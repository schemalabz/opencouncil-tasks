import { applyCorrections, correctTranscript } from '../../tasks/fixTranscript.js';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import type { FixTranscriptRequest, FixTranscriptResult } from '../../types.js';
import type { Case, Expected, FieldOutcome } from '../types.js';
import type { CaseFromRunOptions, Suite } from './suite.js';
import { assertRecordedResult, drafted, recordedMeeting, recordedRequest, recordedRunCase, type RecordedRunCaseInput } from './subjects.js';

/**
 * The expected text of one utterance (`utterance[<utteranceId>]`). `before` is the text
 * the expectation was written against, when it differs: the raw transcript for a recorded
 * run, the text the person edited for an imported UtteranceEdit. Recorded runs give
 * `drafted` values (regression only); a user's UtteranceEdit is an `imported` value with
 * `by`, `at` and `signal`, and those are what a gate reads.
 */
export type UtteranceExpectation = { text: string; before?: string };

/** Every utterance of the request as it reads after the corrections. */
export type FixTranscriptOutput = { texts: Record<string, string>; updated: number };

const normalise = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Levenshtein distance over code points, divided by the longer string's length; 0 for two empty strings. */
export function normalisedEditDistance(a: string, b: string): number {
    const x = [...normalise(a)];
    const y = [...normalise(b)];
    if (x.length === 0 && y.length === 0) return 0;
    let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i++) {
        const row = [i];
        for (let j = 1; j <= y.length; j++) {
            row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
        }
        prev = row;
    }
    return prev[y.length] / Math.max(x.length, y.length);
}

const FIELD = /^utterance\[(.+)\]$/;

type UtteranceOutcome = { field: string; outcome: FieldOutcome; detail: string };

/**
 * An utterance agrees only when its text equals the expected text once whitespace and
 * Unicode form are normalised; the distance is kept in the detail. `closer` means the
 * output moved toward the expected text from `before` without reaching it.
 */
function utteranceOutcomes(output: FixTranscriptOutput, c: Case<RecordedRunCaseInput>): UtteranceOutcome[] {
    return Object.entries(c.expect).flatMap(([field, e]): UtteranceOutcome[] => {
        const m = FIELD.exec(field);
        if (!m) return [];
        const want = e.value as UtteranceExpectation;
        const got = output.texts[m[1]];
        if (got === undefined) return [{ field, outcome: 'missing', detail: 'missing' }];
        const d = normalisedEditDistance(got, want.text);
        if (d === 0) return [{ field, outcome: 'agree', detail: 'exact' }];
        const verdict = want.before === undefined ? 'differs' : d < normalisedEditDistance(want.before, want.text) ? 'closer' : 'no-closer';
        return [{ field, outcome: 'disagree', detail: `${verdict} d=${d.toFixed(3)}` }];
    });
}

export function scoreFixTranscript(output: FixTranscriptOutput, c: Case<RecordedRunCaseInput>): Record<string, FieldOutcome> {
    return Object.fromEntries(utteranceOutcomes(output, c).map(o => [o.field, o.outcome]));
}

/** One drafted expectation per utterance of the request: the recorded correction, or the text left as it was. */
function fixCaseFromRun(suite: string, recorded: ArchivedRun, opts?: CaseFromRunOptions): Case<RecordedRunCaseInput> {
    assertRecordedResult(recorded, 'fixTranscript');
    const meeting = recordedMeeting(recorded, opts);
    const request = recorded.run.input as FixTranscriptRequest;
    const corrected = new Map((recorded.result as FixTranscriptResult).updateUtterances.map(u => [u.utteranceId, u.text]));
    const expect: Record<string, Expected> = {};
    for (const u of request.transcript.flatMap(s => s.utterances)) {
        const text = corrected.get(u.utteranceId);
        const value: UtteranceExpectation = text === undefined ? { text: u.text } : { text, before: u.text };
        expect[`utterance[${u.utteranceId}]`] = drafted(value, recorded);
    }
    return recordedRunCase(suite, recorded, meeting, { meeting }, expect);
}

/**
 * fixTranscript's text corrections (`transcript-fix`, one call per speaker segment),
 * through production's own `correctTranscript`; the speaker identification that reads
 * the corrected text is not run, so a changed correction cannot miss its replay.
 */
export const fixTranscriptSuite: Suite<RecordedRunCaseInput, FixTranscriptOutput> = {
    id: 'fix.transcript',
    task: 'fixTranscript',
    labels: ['transcript-fix'],
    replay: { live: ['transcript-fix'] },
    request: recordedRequest,
    run: async (_c, ctx) => {
        const request = ctx.request as FixTranscriptRequest;
        const { result } = await correctTranscript(request);
        const texts = Object.fromEntries(applyCorrections(request.transcript, result).flatMap(s => s.utterances.map(u => [u.utteranceId, u.text])));
        return { texts, updated: result.length };
    },
    score: scoreFixTranscript,
    detail: (output, c) => Object.fromEntries(utteranceOutcomes(output, c).map(o => [o.field, o.detail])),
    caseFromRun: (recorded, opts) => fixCaseFromRun('fix.transcript', recorded, opts),
};
