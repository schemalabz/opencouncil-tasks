import fs from 'fs';
import { adaToPdfUrl, extractDecisionFromPdf, normalizeExtraction, type RawExtractedDecision } from '../../tasks/utils/decisionPdfExtraction.js';
import { scoreDocument, type ExtractionLabel } from '../../tasks/utils/extractionScoring.js';
import { parseBodyHints } from '../../tasks/utils/bodyHints.js';
import { HUMAN_TIERS, type Case, type FieldOutcome, type Variant } from '../types.js';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import { responseJson } from '../checks/check.js';
import { documentOfCall } from './pollDecisionsRun.js';
import type { CallCase, Suite } from './suite.js';

export type ExtractionInput = { ada: string; pdfUrl: string; city: string; body: string; meta?: unknown };

const hintsCache = new Map<string, Map<string, string>>();

/**
 * Production always sends the body's conventions text, so a variant names the
 * conventions file it was run with; without one the cold reader is scored.
 */
function hintsFor(variant: Variant, c: Case<ExtractionInput>): string | undefined {
    const file = variant.params?.hintsFile as string | undefined;
    if (!file) return undefined;
    let hints = hintsCache.get(file);
    if (!hints) {
        hints = parseBodyHints(fs.readFileSync(file, 'utf8'));
        hintsCache.set(file, hints);
    }
    return hints.get(`${c.input.city}/${c.input.body}`);
}

export function scoreExtraction(output: RawExtractedDecision | null, c: Case<ExtractionInput>): Record<string, FieldOutcome> {
    // A review that settles a contested value (`same`, or picking the value already there)
    // raises its tier but leaves the value's own `verified: false`; the tier is the verdict.
    const settled = (e: Case['expect'][string]) => HUMAN_TIERS.includes(e.tier) && (e.value as { verified?: unknown } | null)?.verified === false
        ? { ...(e.value as object), verified: true } : e.value;
    const label = Object.fromEntries(Object.entries(c.expect).map(([field, e]) => [field, settled(e)])) as unknown as ExtractionLabel;
    const scores = scoreDocument(label, output);
    const out: Record<string, FieldOutcome> = {};
    for (const [field, s] of Object.entries(scores)) {
        out[field] = s.outcome === 'agree' || s.outcome === 'disagree' || s.outcome === 'missing' ? s.outcome : 'unscorable';
    }
    return out;
}

/**
 * The output's answer in the case's label shape, for the fields a person can settle from
 * the page without a reference list. `verified: true` is what a confirmed review makes it:
 * label-confirm writes the value only when a person confirms or corrects it.
 */
export function extractionLabelValue(got: RawExtractedDecision, field: string): unknown {
    switch (field) {
        case 'subject': return { agendaItemNumber: got.subjectInfo?.agendaItemIndex ?? null, isOutOfAgenda: got.subjectInfo?.nonAgendaReason === 'outOfAgenda', verified: true };
        case 'mayor': return got.mayorPresent ? { present: got.mayorPresent.present, verified: true } : undefined;
        case 'presidedBy': return { name: got.presidedBy?.name?.trim() || null, verified: true };
        case 'decisionAttendance': return { members: got.decisionAttendance?.present ?? null, verified: true };
        default: return undefined;
    }
}

const PROPOSED_FIELDS = ['subject', 'mayor', 'presidedBy', 'decisionAttendance'];

/** Only a whole-document read states the document's values; partial and closing reads hold a part. */
function caseFromCall(call: CallRecord, recorded: ArchivedRun): CallCase | undefined {
    if (call.label !== 'decision-extraction') return undefined;
    const doc = documentOfCall(call, recorded);
    const raw = responseJson(call);
    if (!doc || !raw || typeof raw !== 'object') return undefined;
    const got = normalizeExtraction(raw as Parameters<typeof normalizeExtraction>[0]);
    const proposed = Object.fromEntries(PROPOSED_FIELDS.map(f => [f, extractionLabelValue(got, f)]).filter(([, v]) => v !== undefined));
    return {
        caseId: `decisions.extraction/${doc.ada}`,
        newCase: { input: { ada: doc.ada, pdfUrl: doc.pdfUrl, city: doc.city, body: doc.body } satisfies ExtractionInput, cluster: `${doc.city}/${doc.body}`, tags: [doc.city, 'production-call'] },
        proposed,
    };
}

export const decisionsExtraction: Suite<ExtractionInput, RawExtractedDecision> = {
    id: 'decisions.extraction',
    task: 'pollDecisions',
    labels: ['decision-extraction*'],
    run: async (c, ctx) => (await extractDecisionFromPdf(adaToPdfUrl(c.input.ada), undefined, false, hintsFor(ctx.variant, c))).result,
    score: scoreExtraction,
    labelValue: extractionLabelValue,
    caseFromCall,
};
