import type { FixFromMinutesRequest, FixFromMinutesResult, RequestOnTranscript } from "../types.js";
import type { Task } from "./pipeline.js";
import { addUsage, formatUsage, NO_USAGE } from "../lib/ai.js";
import { checkTurns, type CheckOutcome } from "../lib/municipalMinutes/check.js";
import { correctFromTurns } from "../lib/municipalMinutes/corrections.js";
import { matchMinutes, passesGate, type TimedUtterance } from "../lib/municipalMinutes/matching.js";
import { describeSection, fetchMinutesPages, pickSection, splitSections, type MinutesPage } from "../lib/municipalMinutes/read.js";
import { resolveLabels, speakersReport, tagOpinions, toMinutesHints } from "../lib/municipalMinutes/speakers.js";
import { coverage, COVERAGE_FLOOR, cutTurns, parseTurns } from "../lib/municipalMinutes/turns.js";

/**
 * fixFromMinutes: corrects a transcript from the municipality's own verbatim
 * minutes and names the speakers from their labels (schemalabz/opencouncil#876).
 * docs/minutes-correction.md explains the steps, the rules and the report.
 */

export type FixFromMinutesOptions = {
    /** The pages of the document, when the caller has read it already (the CLI reads a local file). */
    pages?: MinutesPage[];
    /** Skip the model check of the turns: the parser's turns stand. */
    skipCheck?: boolean;
    /** The model of the check. */
    checkModel?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Fails a malformed request before the download and the model calls. */
export function checkRequest(request: FixFromMinutesRequest): void {
    const problems: string[] = [];
    if (typeof request.municipalMinutesUrl !== "string" || !/^https?:\/\//.test(request.municipalMinutesUrl)) problems.push("municipalMinutesUrl must be an http(s) URL");
    if (typeof request.meetingDate !== "string" || !ISO_DATE.test(request.meetingDate)) problems.push("meetingDate must be YYYY-MM-DD");
    if (request.sessionNumber !== null && !Number.isInteger(request.sessionNumber)) problems.push("sessionNumber must be an integer or null");
    if (!Array.isArray(request.transcript) || request.transcript.some(s => !Array.isArray(s.utterances))) problems.push("transcript must be a list of segments with utterances");
    if (problems.length > 0) throw new Error(`invalid request: ${problems.join("; ")}`);
}

/** Our utterances in time order, each with its segment's speaker tag and speaker. */
export function timedUtterances(transcript: RequestOnTranscript["transcript"]): TimedUtterance[] {
    return transcript
        .flatMap(segment => segment.utterances.map(u => ({
            utteranceId: u.utteranceId,
            text: u.text,
            start: u.startTimestamp,
            end: u.endTimestamp,
            speakerTagId: segment.speakerTagId ?? null,
            speakerId: segment.speakerId,
        })))
        .sort((a, b) => a.start - b.start);
}

export async function fixFromMinutesWith(request: FixFromMinutesRequest, onProgress: (stage: string, progress: number) => void, options: FixFromMinutesOptions = {}): Promise<FixFromMinutesResult> {
    if (!options.pages) checkRequest(request);
    const roster = request.people ?? [];
    let usage = NO_USAGE;

    onProgress("reading the minutes", 0.05);
    const pages = options.pages ?? await fetchMinutesPages(request.municipalMinutesUrl);
    const sections = splitSections(pages);
    const section = pickSection(sections, request.meetingDate, request.sessionNumber);
    console.log(`Minutes: ${pages.length} pages, ${sections.length} section(s); reading ${describeSection(section)}, ${section.stripped} running lines stripped`);

    onProgress("cutting the minutes into turns", 0.15);
    const parsed = parseTurns(section.lines, roster);
    console.log(`Parser: ${parsed.turns.length} turns, ${new Set(parsed.turns.map(t => t.key)).size} labels, ${parsed.rejectedLabels.length} candidate labels rejected`);
    let check: CheckOutcome = { boundaries: parsed.boundaries, added: 0, removed: 0, dropped: 0, failedChunks: 0 };
    if (!options.skipCheck) {
        const checked = await checkTurns(parsed.section, parsed.boundaries, {
            model: options.checkModel,
            onChunkDone: (done, total) => onProgress("checking the turns", 0.15 + 0.3 * (done / total)),
        });
        usage = addUsage(usage, checked.usage);
        check = checked.result;
        console.log(`Check: ${check.added} turn starts added, ${check.removed} labels removed, ${check.dropped} answers dropped, ${check.failedChunks} chunk(s) failed`);
    }
    const turns = cutTurns(parsed.section, check.boundaries);
    const covered = coverage(parsed.section, turns);
    console.log(`Coverage: ${(covered * 100).toFixed(1)}% of the section's text from the first turn on, in ${turns.length} turns`);
    if (covered < COVERAGE_FLOOR) {
        throw new Error(`only ${Math.round(covered * 100)}% of the minutes falls inside speaker turns (floor ${Math.round(COVERAGE_FLOOR * 100)}%): the document does not read as verbatim minutes`);
    }

    onProgress("aligning the minutes with the transcript", 0.5);
    const utterances = timedUtterances(request.transcript);
    const matching = matchMinutes(turns, utterances);
    const alignedTurns = matching.turns.filter(t => t.matched > 0);
    const underGate = alignedTurns.filter(t => !passesGate(t));
    const unmatched = matching.utterances.filter(u => u.matched === 0).length;
    console.log(`Alignment: ${alignedTurns.length}/${turns.length} turns aligned, ${underGate.length} under the verbatim gate, ${unmatched}/${utterances.length} utterances unmatched, ${matching.alignment.unaligned.length} gap(s) left unaligned`);

    onProgress("correcting the transcript", 0.7);
    const { corrections, counts } = correctFromTurns(turns, utterances, matching);
    console.log(`Corrections: ${counts.substitutions} substitutions in ${counts.utterancesChanged} utterances; ${counts.insertionsSkipped} insertions and ${counts.deletionsSkipped} deletions counted, not written`);

    onProgress("naming the speakers", 0.85);
    const resolved = await resolveLabels(turns, roster, request.administrativeBodyName || null);
    usage = addUsage(usage, resolved.usage);
    const opinions = tagOpinions(turns, utterances, matching, resolved.result);
    const speakers = speakersReport(opinions, utterances, turns, resolved.result);
    const speakersPassRan = roster.length > 0 && utterances.some(u => u.speakerTagId !== null);
    console.log(`Speakers: ${speakers.actionable} actionable opinions, ${speakers.contested.length} contested tags, ${speakers.disagreements.length} disagreements, ${speakers.unresolvedLabels.length} unresolved labels${speakersPassRan ? "" : " (no roster or no speaker tags: no hints)"}`);
    console.log(`Total usage: ${formatUsage(usage)}`);

    return {
        updateUtterances: corrections,
        ...(speakersPassRan ? { speakerHints: toMinutesHints(opinions) } : {}),
        report: {
            document: {
                section: sections.length > 1 ? { page: section.page, pages: section.pages } : null,
                coverage: covered,
                checkAdded: check.added,
                checkRemoved: check.removed,
                checkDropped: check.dropped,
                checkFailedChunks: check.failedChunks,
            },
            alignment: { turns: turns.length, alignedTurns: alignedTurns.length, turnsUnderGate: underGate.length, utterancesUnmatched: unmatched },
            corrections: counts,
            speakers,
        },
    };
}

export const fixFromMinutes: Task<FixFromMinutesRequest, FixFromMinutesResult> = (request, onProgress) => fixFromMinutesWith(request, onProgress);
