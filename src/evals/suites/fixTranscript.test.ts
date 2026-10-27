import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import type { ArchivedRun } from '../../lib/telemetry/archiveSink.js';
import type { FixTranscriptRequest } from '../../types.js';
import { caseSetSha, writeCase } from '../cases/caseStore.js';
import { lintCases } from '../cases/lint.js';
import { compareRuns, type ComparableRun } from '../compare/compare.js';
import { evaluateGate, loadGate } from '../compare/gate.js';
import type { Case, ResultRow, RunManifest } from '../types.js';
import { fixTranscriptSuite, normalisedEditDistance, type FixTranscriptOutput, type UtteranceExpectation } from './fixTranscript.js';

const utterance = (utteranceId: string, text: string) => ({ utteranceId, text, startTimestamp: 0, endTimestamp: 1 });
const request = {
    cityName: 'Ζωγράφου', cityLanguage: 'el',
    transcript: [{ speakerName: 'Α', utterances: [utterance('u1', 'Συνάδ\\ελφοι, να ξεκινήσουμε;'), utterance('u2', 'Καλημέρα σας.')] }],
} as unknown as FixTranscriptRequest;

function recorded(): ArchivedRun {
    return {
        run: { traceId: 'e'.repeat(32), taskType: 'fixTranscript', taskVersion: 3, taskId: 'x', env: 'development', input: request, startedAt: '2026-10-10T00:00:00Z' },
        outcome: { status: 'success', endedAt: '2026-10-10T00:01:00Z' }, phases: [], calls: [], key: 'k',
        result: { updateUtterances: [{ utteranceId: 'u1', text: 'Συνάδελφοι, να ξεκινήσουμε;', markUncertain: false }] },
    };
}

const output = (texts: Record<string, string>): FixTranscriptOutput => ({ texts, updated: 0 });

describe('normalisedEditDistance', () => {
    it('is 0 for texts that differ only in whitespace or Unicode form, and the share of edits otherwise', () => {
        expect(normalisedEditDistance(' Καλημέρα  σας. ', 'Καλημέρα σας.')).toBe(0);
        expect(normalisedEditDistance('Καλημέρα', 'Καλημέρα')).toBe(0);
        expect(normalisedEditDistance('abcd', 'abed')).toBe(0.25);
        expect(normalisedEditDistance('', '')).toBe(0);
        expect(normalisedEditDistance('abc', '')).toBe(1);
    });
});

describe('fix.transcript', () => {
    it('needs the meeting for a run recorded without one', () => {
        expect(() => fixTranscriptSuite.caseFromRun!(recorded())).toThrow(/pass --meeting/);
    });

    const c = fixTranscriptSuite.caseFromRun!(recorded(), { meeting: 'zografou/sep8_2026' });

    it('expects every utterance of the request, drafted: the recorded correction, or the text as it was', () => {
        expect(c.id).toBe('fix.transcript/zografou-sep8_2026');
        expect(c.cluster).toBe('zografou');
        expect(c.expect['utterance[u1]'].value).toEqual({ text: 'Συνάδελφοι, να ξεκινήσουμε;', before: 'Συνάδ\\ελφοι, να ξεκινήσουμε;' });
        expect(c.expect['utterance[u2]'].value).toEqual({ text: 'Καλημέρα σας.' });
        expect(Object.values(c.expect).every(e => e.tier === 'drafted')).toBe(true);
    });

    it('agrees only on the expected text, and says whether a miss moved toward it', () => {
        const recordedTexts = { u1: 'Συνάδελφοι, να ξεκινήσουμε;', u2: 'Καλημέρα σας.' };
        expect(fixTranscriptSuite.score(output(recordedTexts), c)).toEqual({ 'utterance[u1]': 'agree', 'utterance[u2]': 'agree' });
        const changed = output({ u1: 'Συνάδ\\ελφοι, να ξεκινήσουμε;', u2: 'Καλημέρα σας!' });
        expect(fixTranscriptSuite.score(changed, c)).toEqual({ 'utterance[u1]': 'disagree', 'utterance[u2]': 'disagree' });
        expect(fixTranscriptSuite.detail!(changed, c)).toEqual({ 'utterance[u1]': 'no-closer d=0.036', 'utterance[u2]': 'differs d=0.077' });
        expect(fixTranscriptSuite.score(output({ u1: recordedTexts.u1 }), c)['utterance[u2]']).toBe('missing');
    });
});

/**
 * No case carries human truth yet. This builds the shape S5 will write from a user's
 * UtteranceEdit and drives it through compare and the checked-in gate.
 */
describe('fix.transcript with imported UtteranceEdits', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const human = (text: string, before: string) => ({
        value: { text, before } satisfies UtteranceExpectation, tier: 'imported' as const, by: 'user:cm-editor', at: '2026-10-01',
        source: 'signal:utterance-edit', signal: 'utterance-edit:cm-edit-1',
    });
    const cases: Case<{ meeting: string }>[] = Array.from({ length: 6 }, (_, i) => ({
        id: `fix.transcript/city${i}-oct1_2026`, suite: 'fix.transcript', split: 'holdout', input: { meeting: `city${i}/oct1_2026` }, replay: null,
        expect: { 'utterance[u1]': human('Ο Παπαδόπουλος είπε ναι.', 'Ο Παπαδόπουλο είπε ναι.') }, cluster: `city${i}`, tags: [],
    }));

    const manifest = (name: string, ranOn: Case[]): RunManifest => ({
        runId: name, suite: 'fix.transcript', variant: { name, overrides: {} }, split: 'all', reps: 1, cases: ranOn.length,
        caseSetSha: caseSetSha(ranOn), gitRef: 'g', gitDirty: false, startedAt: 't', spentUsd: 0, status: 'complete',
    });
    const run = (name: string, textOf: (c: Case<{ meeting: string }>) => string, ranOn = cases): ComparableRun => ({
        manifest: manifest(name, ranOn), errors: [],
        rows: ranOn.map((c): ResultRow => {
            const out = output({ u1: textOf(c) });
            return { caseId: c.id, rep: 0, fields: fixTranscriptSuite.score(out, c), checks: {}, usage: { input_tokens: 0, output_tokens: 0 },
                costUsd: 0.01, latencyMs: 1, servedModels: [], status: 'ok', traceId: '', output: out };
        }),
    });
    const right = () => 'Ο Παπαδόπουλος είπε ναι.';
    const gate = loadGate('fix.transcript', root);

    it('passes the lint: an imported value names its signal', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-cases-'));
        writeCase(cases[0], dir);
        expect(lintCases(dir)).toEqual([]);
        const unsigned = { ...cases[0], expect: { 'utterance[u1]': { ...cases[0].expect['utterance[u1]'], signal: undefined } } };
        writeCase(unsigned, dir);
        expect(lintCases(dir).map(i => i.rule)).toEqual(['imported-signal']);
    });

    it('passes a change that keeps every human text, and fails one that loses some', () => {
        expect(evaluateGate(compareRuns(run('a', right), run('b', right), cases), gate)).toEqual({ verdict: 'PASS', reasons: [] });
        const worse = run('b', c => (c.cluster === 'city0' || c.cluster === 'city1' ? 'Ο Παπαδόπουλο είπε ναι.' : right()));
        const r = evaluateGate(compareRuns(run('a', right), worse, cases), gate);
        expect(r.verdict).toBe('FAIL');
        expect(r.reasons[0]).toMatch(/^utterance: 2 human-tier holdout regression\(s\)/);
    });

    it('needs review below five human-backed holdout cases', () => {
        const few = cases.slice(0, 4);
        const r = evaluateGate(compareRuns(run('a', right, few), run('b', right, few), few), gate);
        expect(r).toEqual({ verdict: 'NEEDS_REVIEW', reasons: ['only 4 case(s) carry human-tier holdout values; this gate needs 5'] });
    });
});
