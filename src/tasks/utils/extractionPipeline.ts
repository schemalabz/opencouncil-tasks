import Anthropic from '@anthropic-ai/sdk';
import { addUsage, NO_USAGE } from '../../lib/ai.js';
import { ExtractedDecisionResult } from '../../types.js';
import {
    extractDecisionFromPdf,
    RawExtractedDecision,
    matchPersonByName,
    llmMatchMembers,
    PersonForMatching,
} from './decisionPdfExtraction.js';
import { toDocumentEvents } from './meetingAttendance.js';
import { validateRawExtraction, validateProcessedDecision, type DecisionWarning } from './decisionValidation.js';

export interface ExtractionSubject {
    subjectId: string;
    name: string;
    agendaItemIndex: number | null;
    decision: {
        pdfUrl: string;
        ada: string | null;
        protocolNumber: string | null;
    };
}

export interface ExtractionPipelineResult {
    decisions: ExtractedDecisionResult[];
    warnings: string[];
    usage: Anthropic.Messages.Usage;
}

const BATCH_SIZE = 5;

/**
 * Extract structured decision data from PDFs.
 *
 * Returns what each document states, never what follows from it or from the
 * other documents: the page's roll call, its arrivals and departures with the
 * anchor each was printed against, the voters it names, and how each name was
 * matched. Everything that combines pages happens in opencouncil, over every
 * stored reading (C1).
 *
 * @param subjects - Subjects with linked decisions (have PDF URLs)
 * @param allMeetingSubjects - ALL subjects in the meeting (for discussion order + non-decision attendance)
 * @param people - People for name matching
 */
export async function extractDecisionsFromPdfs(
    subjects: ExtractionSubject[],
    people: PersonForMatching[],
    onProgress: (stage: string, percent: number) => void,
    mayorId?: string,
    skipCache?: boolean,
    /** The body's conventions as sentences for the prompt (rendered by opencouncil from its glossary). */
    hints?: string | null,
): Promise<ExtractionPipelineResult> {
    const taskStart = Date.now();
    const warnings: string[] = [];
    let totalUsage: Anthropic.Messages.Usage = { ...NO_USAGE };

    const mayorName = mayorId
        ? people.find(p => p.id === mayorId)?.name
        : undefined;

    console.log(`\n--- extractDecisionsFromPdfs ---`);
    console.log(`Subjects with decisions: ${subjects.length}`);
    console.log(`People for matching: ${people.length}`);
    if (mayorName) console.log(`Mayor: ${mayorName} (${mayorId})`);

    if (subjects.length === 0) {
        return { decisions: [], warnings: [], usage: totalUsage };
    }

    // --- Phase 1: Extract all PDFs (batched for concurrency) ---
    const extractions: { subjectId: string; agendaItemIndex: number | null; raw: RawExtractedDecision; usage: Anthropic.Messages.Usage; fromCache: boolean; readWarnings: DecisionWarning[] }[] = [];
    let completed = 0;

    for (let i = 0; i < subjects.length; i += BATCH_SIZE) {
        const batch = subjects.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
            batch.map(async (subject, batchIdx) => {
                const idx = i + batchIdx;
                const pdfUrl = subject.decision.pdfUrl;
                console.log(`\n[PDF ${idx + 1}/${subjects.length}] Subject: "${subject.name}"`);
                console.log(`  URL: ${pdfUrl}`);

                const pdfStart = Date.now();
                const { result: raw, usage: pdfUsage, fromCache, warnings: readWarnings = [] } = await extractDecisionFromPdf(pdfUrl, mayorName, skipCache, hints ?? undefined);
                const elapsed = ((Date.now() - pdfStart) / 1000).toFixed(1);

                console.log(`  Excerpt: ${raw.decisionExcerpt?.length ?? 0} chars`);
                console.log(`  Vote: ${raw.voteResult ?? '(none)'}`);
                console.log(`  Present: ${raw.presentMembers?.length ?? 0}, Absent: ${raw.absentMembers?.length ?? 0}`);
                console.log(`  SubjectInfo: ${raw.subjectInfo ? `#${raw.subjectInfo.agendaItemIndex}${raw.subjectInfo.nonAgendaReason ? ' (out-of-agenda)' : ''}` : '(none)'}`);
                if (fromCache) console.log(`  (from cache)`);
                console.log(`  Done in ${elapsed}s`);

                return { subjectId: subject.subjectId, agendaItemIndex: subject.agendaItemIndex, raw, usage: pdfUsage, fromCache, readWarnings };
            })
        );

        for (let j = 0; j < batchResults.length; j++) {
            const result = batchResults[j];
            if (result.status === 'fulfilled') {
                extractions.push(result.value);
                totalUsage = addUsage(totalUsage, result.value.usage);
            } else {
                const subject = batch[j];
                const msg = result.reason instanceof Error ? result.reason.message : 'Unknown error';
                console.error(`  [PDF ${i + j + 1}] FAILED for "${subject.name}" (${subject.decision.pdfUrl}): ${msg}`);
                warnings.push(`Failed to extract data from decision PDF for "${subject.name}" (${subject.decision.pdfUrl}): ${msg}`);
            }
        }

        completed += batch.length;
        const progressPercent = (completed / subjects.length) * 100;
        onProgress(`extracted ${completed}/${subjects.length} PDFs`, progressPercent);
    }

    // --- Phase 2: Meeting-level name matching ---
    onProgress('matching members', 100);

    // Collect all unique raw names across all decisions + attendance changes
    const allRawNames = new Set<string>();
    for (const { raw } of extractions) {
        for (const name of raw.presentMembers || []) allRawNames.add(name);
        for (const name of raw.absentMembers || []) allRawNames.add(name);
        for (const detail of raw.voteDetails || []) allRawNames.add(detail.name);
        for (const change of raw.attendanceChanges || []) allRawNames.add(change.name);
        for (const name of raw.decisionAttendance?.present ?? []) allRawNames.add(name);
        if (raw.presidedBy?.name) allRawNames.add(raw.presidedBy.name);
        if (raw.actingSecretary?.name) allRawNames.add(raw.actingSecretary.name);
    }

    // Step 1: Token-sort matching — build name→personId map
    const nameToPersonId = new Map<string, string>();
    const matchMethod = new Map<string, 'token' | 'llm'>();
    for (const rawName of allRawNames) {
        const personId = matchPersonByName(rawName, people);
        if (personId) {
            nameToPersonId.set(rawName, personId);
            matchMethod.set(rawName, 'token');
        }
    }
    const step1Unmatched = [...allRawNames].filter(n => !nameToPersonId.has(n));

    console.log(`\n--- Meeting-level matching ---`);
    console.log(`  Unique names: ${allRawNames.size}`);
    console.log(`  Token-sort matched: ${nameToPersonId.size}`);
    console.log(`  Remaining for LLM: ${step1Unmatched.length}`);

    // Step 2: LLM fallback for remaining unmatched
    if (step1Unmatched.length > 0) {
        try {
            const llmResult = await llmMatchMembers(step1Unmatched, people);
            totalUsage = addUsage(totalUsage, llmResult.usage);
            for (const { name, personId } of llmResult.matched) {
                nameToPersonId.set(name, personId);
                matchMethod.set(name, 'llm');
            }
            console.log(`  LLM matched: ${llmResult.matched.length}`);
            console.log(`  Still unmatched: ${llmResult.stillUnmatched.length}`);
            if (llmResult.stillUnmatched.length > 0) {
                console.log(`  Unmatched names: ${llmResult.stillUnmatched.join(', ')}`);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.warn(`  LLM matching failed: ${msg}`);
            warnings.push(`LLM name matching failed: ${msg}`);
        }
    }

    console.log(`  Final matched: ${nameToPersonId.size}/${allRawNames.size}`);

    // --- Phase 4: Build decision results ---
    // What each document states, matched to ids. Replay of presence and FOR
    // inference happen in the app, over stored rows.
    const decisions: ExtractedDecisionResult[] = [];
    const resolve = (name: string) => nameToPersonId.get(name) ?? null;
    const ids = (names: string[]) => [...new Set(names.map(resolve).filter((id): id is string => !!id))];

    for (const { subjectId, raw, fromCache, readWarnings } of extractions) {
        // The members the page names. Whoever kept the minutes is left out: the matcher
        // still tries the name (allRawNames), but it may be an employee on no roster
        // (Argithea), and an unmatched member would then be reported on every page.
        const namedOnPage = [...raw.presentMembers, ...raw.absentMembers, ...raw.voteDetails.map(v => v.name), ...raw.attendanceChanges.map(c => c.name), ...(raw.decisionAttendance?.present ?? []), ...(raw.presidedBy?.name ? [raw.presidedBy.name] : [])];
        const unmatchedMembers = [...new Set(namedOnPage.filter(n => !resolve(n)))];
        // A page that names the same councillor twice — once in the dissenting
        // list, once in a declaration line — states one vote, not two.
        const seenVoterIds = new Set<string>();
        const voteDetails = raw.voteDetails.flatMap(v => {
            const personId = resolve(v.name);
            if (!personId || seenVoterIds.has(personId)) return [];
            seenVoterIds.add(personId);
            return [{ personId, name: v.name, vote: v.vote }];
        });
        const attendanceChanges = toDocumentEvents(raw.attendanceChanges, subjectId, resolve);
        const presidedBy = raw.presidedBy
            ? { name: raw.presidedBy.name, personId: resolve(raw.presidedBy.name) ?? matchPersonByName(raw.presidedBy.name, people), rawText: raw.presidedBy.rawText }
            : null;
        const actingSecretary = raw.actingSecretary
            ? { name: raw.actingSecretary.name, personId: resolve(raw.actingSecretary.name) ?? matchPersonByName(raw.actingSecretary.name, people), rawText: raw.actingSecretary.rawText }
            : null;
        const warnings = [...readWarnings, ...validateRawExtraction(raw), ...validateProcessedDecision({ voteResult: raw.voteResult, voteDetails: voteDetails.map(v => ({ vote: v.vote })) })];

        decisions.push({
            subjectId,
            excerpt: raw.decisionExcerpt || '',
            references: raw.references || '',
            decisionNumber: raw.decisionNumber || null,
            subjectInfo: raw.subjectInfo
                ? { number: raw.subjectInfo.agendaItemIndex, isOutOfAgenda: raw.subjectInfo.nonAgendaReason !== null }
                : null,
            incomplete: raw.incomplete,
            rollCall: {
                layout: raw.attendanceFormat === 'composition_and_absent' ? 'composition_and_absent' : 'present_and_absent',
                composition: raw.compositionMembers ?? [],
                present: raw.presentMembers,
                absent: raw.absentMembers,
                presentIds: ids(raw.presentMembers),
                absentIds: ids(raw.absentMembers),
            },
            mayorPresent: raw.mayorPresent,
            presidedBy,
            actingSecretary,
            subjectHeading: raw.subjectHeading,
            decisionAttendance: raw.decisionAttendance ? { present: raw.decisionAttendance.present, presentIds: ids(raw.decisionAttendance.present), rawText: raw.decisionAttendance.rawText } : null,
            voteResult: raw.voteResult || null,
            voteTally: raw.voteTally,
            voteDetails,
            attendanceChanges,
            unmatchedMembers,
            // How each name the page states was matched, so a wrong match can be seen and checked (spec §4.2).
            nameMatches: [...new Set([...namedOnPage, ...(raw.actingSecretary?.name ? [raw.actingSecretary.name] : [])])]
                .map(name => ({ name, personId: resolve(name), method: matchMethod.get(name) ?? null })),
            fromCache,
            warnings,
        });

        console.log(`  [${subjectId}] ${raw.presentMembers.length} present, ${raw.absentMembers.length} absent as printed, ${voteDetails.length} named votes, ${attendanceChanges.length} changes`);
        if (unmatchedMembers.length > 0) {
            console.warn(`  ⚠ [${subjectId}] ${unmatchedMembers.length} unmatched members: ${unmatchedMembers.map(n => `"${n}"`).join(', ')}`);
        }
    }

    const totalElapsed = ((Date.now() - taskStart) / 1000).toFixed(1);
    console.log(`\n--- extractDecisionsFromPdfs DONE (${totalElapsed}s) ---`);
    console.log(`  Extracted: ${extractions.length}/${subjects.length}`);
    console.log(`  Warnings: ${warnings.length}`);

    return { decisions, warnings, usage: totalUsage };
}
