import fs from 'fs';
import type { PollDecisionsRequest } from '../../../types.js';
import { casesRoot, privateCasesRoot, readCase, writeCase } from '../../cases/caseStore.js';
import { matchingCase, type MatchingInput, type MatchingLinks } from '../../suites/decisionsMatching.js';
import { speakerIdCase, type TagSignal } from '../../suites/fixSpeakerId.js';
import type { MeetingApiData } from '../../suites/speakerBacktest.js';
import type { Case, Expected } from '../../types.js';

/**
 * Signals exported from an opencouncil database by its export-eval-signals script:
 * corrections people made, each with the write that proves a person made it. They become
 * `imported` expectations without review. The cases hold production content,
 * so they are written to the private case root, never to `evals/cases`.
 */
export type OpencouncilSignal = {
    kind: 'decision-link' | 'speaker-tag' | 'utterance-edit';
    action: string;
    ids: Record<string, string | null>;
    before: unknown;
    after: unknown;
    by: string;
    at: string;
    evidence: string;
    taskOutput?: string | null;
};

/** The inputs a case is rebuilt from: not a person's action. */
export type OpencouncilContext = {
    kind: 'decision-window' | 'speaker-meeting' | 'fix-request';
    ids: Record<string, string>;
    value: unknown;
};

export const SIGNAL_SUITES = ['decisions.matching', 'fix.speaker-id'] as const;

export function readSignalFile(file: string): { signals: OpencouncilSignal[]; contexts: OpencouncilContext[] } {
    const signals: OpencouncilSignal[] = [];
    const contexts: OpencouncilContext[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as OpencouncilSignal | OpencouncilContext;
        if (row.kind === 'decision-window' || row.kind === 'speaker-meeting' || row.kind === 'fix-request') contexts.push(row as OpencouncilContext);
        else signals.push(row as OpencouncilSignal);
    }
    return { signals, contexts };
}

const meetingOf = (ids: Record<string, string | null>) => `${ids.cityId}/${ids.meetingId}`;

/** The signal's id as a case cites it: kind, action and the row it was read from. */
export function signalRef(s: OpencouncilSignal): string {
    const row = s.kind === 'decision-link' ? (s.action === 'dismiss' ? s.ids.candidateId : s.ids.decisionId)
        : s.kind === 'speaker-tag' ? s.ids.speakerTagId : s.ids.utteranceId;
    return `opencouncil:${s.kind}:${s.action}:${row}`;
}

const provenance = (s: OpencouncilSignal) => ({ by: s.by, at: s.at.slice(0, 10), source: `opencouncil:${s.kind}`, signal: signalRef(s) });

type DecisionWindow = Omit<MatchingInput, 'meeting'> & { links?: { subjectId: string; ada: string | null; byTask: boolean }[] };

/** One case per meeting window that holds at least one person's link or dismissal. */
export function matchingCases(signals: OpencouncilSignal[], contexts: OpencouncilContext[], now = new Date()): { cases: Case<MatchingInput>[]; skipped: string[] } {
    const windows = new Map(contexts.filter(c => c.kind === 'decision-window').map(c => [meetingOf(c.ids), c.value as DecisionWindow]));
    const byMeeting = new Map<string, OpencouncilSignal[]>();
    for (const s of signals.filter(s => s.kind === 'decision-link')) byMeeting.set(meetingOf(s.ids), [...(byMeeting.get(meetingOf(s.ids)) ?? []), s]);

    const cases: Case<MatchingInput>[] = [];
    const skipped: string[] = [];
    for (const [meeting, list] of byMeeting) {
        const window = windows.get(meeting);
        if (!window) { skipped.push(`${meeting}: no decision-window context (export with --contexts)`); continue; }
        const { links: stored = [], ...request } = window;
        const subjectIds = new Set(request.subjects.map(s => s.subjectId));
        const links: MatchingLinks = { human: new Map(), rejected: new Map(), task: new Map() };
        for (const l of stored) if (l.byTask && l.ada) links.task.set(l.subjectId, l.ada);
        for (const s of list) {
            if (s.action === 'dismiss') {
                if (s.ids.ada) links.rejected.set(s.ids.ada, { subjectId: s.ids.subjectId, expected: provenance(s) });
                continue;
            }
            const subjectId = s.ids.subjectId!;
            // A document with no ΑΔΑ is not on Diavgeia: matching can never find it.
            if (!s.ids.ada) { skipped.push(`${meeting}: ${signalRef(s)} links a document with no ΑΔΑ`); continue; }
            if (!subjectIds.has(subjectId)) { skipped.push(`${meeting}: ${signalRef(s)} links a subject the poll request does not hold`); continue; }
            links.human.set(subjectId, { ada: s.ids.ada, expected: provenance(s) });
        }
        if (links.human.size === 0 && links.rejected.size === 0) { skipped.push(`${meeting}: no scorable person's action`); continue; }
        cases.push(matchingCase({ meeting, ...(request as Omit<MatchingInput, 'meeting'>), subjects: request.subjects as PollDecisionsRequest['subjects'] }, links, now));
    }
    return { cases, skipped };
}

/** One case per meeting whose payload was exported beside its reviewers' speaker tags. */
export function speakerIdCases(signals: OpencouncilSignal[], contexts: OpencouncilContext[], now = new Date()): { cases: Case[]; skipped: string[] } {
    const payloads = new Map(contexts.filter(c => c.kind === 'speaker-meeting').map(c => [meetingOf(c.ids), c.value as MeetingApiData]));
    const byMeeting = new Map<string, Map<string, TagSignal>>();
    for (const s of signals.filter(s => s.kind === 'speaker-tag')) {
        const tags = byMeeting.get(meetingOf(s.ids)) ?? new Map<string, TagSignal>();
        tags.set(s.ids.speakerTagId!, { by: s.by, at: s.at.slice(0, 10), signal: signalRef(s) });
        byMeeting.set(meetingOf(s.ids), tags);
    }
    const cases: Case[] = [];
    const skipped: string[] = [];
    for (const [meeting, tags] of byMeeting) {
        const data = payloads.get(meeting);
        if (!data) { skipped.push(`${meeting}: no speaker-meeting context (export with --contexts --meeting ${meeting})`); continue; }
        const c = speakerIdCase(meeting, data, tags, now);
        if (!Object.values(c.expect).some(e => e.tier === 'imported')) { skipped.push(`${meeting}: no reviewer's tag the record can score`); continue; }
        cases.push(c);
    }
    return { cases, skipped };
}

/** The expected text of one utterance, as `fix.transcript` stores it (`utterance[<utteranceId>]`). */
export type UtteranceExpectation = { text: string; before?: string };

/**
 * A reviewer's edit as a `fix.transcript` expectation: the person's final text, against
 * the text fixTranscript was given (`before`). A case that uses it must run the
 * request the signal names (`ids.taskStatusId`, the `fix-request` context), since
 * `before` is that request's text.
 */
export function utteranceEditExpectation(s: OpencouncilSignal): { field: string; expected: Expected } {
    if (s.kind !== 'utterance-edit') throw new Error(`${signalRef(s)} is not an utterance edit`);
    const value: UtteranceExpectation = { text: s.after as string, ...(s.before !== s.after && { before: s.before as string }) };
    return { field: `utterance[${s.ids.utteranceId}]`, expected: { value, tier: 'imported', ...provenance(s) } };
}

export type OpencouncilHarvest = { written: string[]; updated: string[]; skipped: string[]; unused: Record<string, number> };

/**
 * Writes the imported cases a signal file yields. A case written before keeps its split
 * and history, so a re-export never moves a case between dev and holdout. A case already
 * committed is left alone, so it never grows a diverging private copy.
 */
export function harvestOpencouncil(file: string, opts: { suite?: string; root?: string; now?: Date } = {}): OpencouncilHarvest {
    const { signals, contexts } = readSignalFile(file);
    const root = opts.root ?? privateCasesRoot();
    const wanted = (suite: string) => !opts.suite || opts.suite === suite;
    if (opts.suite && !(SIGNAL_SUITES as readonly string[]).includes(opts.suite)) {
        throw new Error(`No opencouncil signals feed suite "${opts.suite}" (known: ${SIGNAL_SUITES.join(', ')})`);
    }
    const built = [
        ...(wanted('decisions.matching') ? [matchingCases(signals, contexts, opts.now)] : []),
        ...(wanted('fix.speaker-id') ? [speakerIdCases(signals, contexts, opts.now)] : []),
    ];
    const out: OpencouncilHarvest = { written: [], updated: [], skipped: built.flatMap(b => b.skipped), unused: {} };
    const committed = casesRoot();
    for (const c of built.flatMap(b => b.cases as Case[])) {
        if (root !== committed && readCase(c.id, committed)) {
            out.skipped.push(`${c.id}: already committed under ${committed}`);
            continue;
        }
        const existing = readCase(c.id, root);
        const path = writeCase(existing ? { ...c, split: existing.split, history: existing.history } : c, root);
        (existing ? out.updated : out.written).push(path);
    }
    const edits = signals.filter(s => s.kind === 'utterance-edit').length;
    if (edits) out.unused['utterance-edit (fix.transcript consumes them; see utteranceEditExpectation)'] = edits;
    return out;
}
