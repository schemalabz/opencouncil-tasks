import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveKeys, fsStore, type ArchiveStore } from '../../lib/archive/store.js';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import { encodeRunFile } from '../../lib/telemetry/archiveSink.js';
import { assignSplit, readCase, writeCase } from '../cases/caseStore.js';
import { lintCases } from '../cases/lint.js';
import { runDetectorCases } from '../checks/runDetectorCases.js';
import { loadModes, repoRoot } from '../registry/registry.js';
import type { Candidate } from '../harvest/candidate.js';
import type { Case, ResultRow, RunManifest } from '../types.js';
import { makeRun, makeSubject } from '../../lib/runs/fixtures.js';
import { readArchivedRun } from '../../lib/telemetry/archiveSink.js';
import { summarizeContributions } from '../suites/summarize.js';
import type { PreferenceRecord } from './apply.js';
import { applyBatch, planApply, writePlan } from './apply.js';
import { loadBatch, resultsErrors, saveBatch, submitResults, type ReviewBatch, type ReviewResults } from './batch.js';
import { blindOptions, buildBatch, buildPairwiseBatch } from './build.js';
import { renderPage } from './render/page.js';
import { serveBatch } from './server.js';

const PDF = Buffer.from('%PDF-1.4 fake decision page');
const PDF_SHA = 'ab'.repeat(32);

async function archiveRun(store: ArchiveStore, traceId: string, calls: CallRecord[]) {
    const run = { traceId, taskType: 'pollDecisions', taskVersion: 1, taskId: 'x', env: 'eval' as const, startedAt: '2026-10-10T10:00:00.000Z' };
    const key = archiveKeys.calls('eval', new Date(run.startedAt), run.taskType, traceId);
    await store.put(key, encodeRunFile({ run, phases: [], calls }, { status: 'success', endedAt: run.startedAt }));
    await store.put(archiveKeys.traceIndex(traceId), key);
}

const readingCall = (traceId: string): CallRecord => ({
    v: 1, callId: 'call-r', traceId, label: 'decision-reading', cacheKey: 'k', startedAt: '', finishedAt: '',
    request: { model: 'claude-haiku-4-5', max_tokens: 1024, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'blob', sha256: PDF_SHA, media_type: 'application/pdf', bytes: PDF.length } }, { type: 'text', text: 'Read it' }] }] },
    response: { servedModel: 'claude-haiku-4-5', stopReason: 'end_turn', text: '{"meetingDate":"2026-07-19"}', usage: {}, latencyMs: 1, batchMode: false },
});

const drafted = (value: unknown) => ({ value, tier: 'drafted' as const, by: 'agent', at: '2026-10-01', source: 'cross-model:agree' });

describe('label-confirm review of decisions.reading, end to end', () => {
    let dir: string;
    let casesRoot: string;
    let store: ArchiveStore;
    const existing: Case = {
        id: 'decisions.reading/91ΙΜΩΨ3-ΤΑ6', suite: 'decisions.reading', split: 'dev',
        input: { ada: '91ΙΜΩΨ3-ΤΑ6', pdfUrl: 'https://diavgeia.gov.gr/doc/91ΙΜΩΨ3-ΤΑ6' },
        expect: { meetingDate: drafted('2026-07-18'), decisionNumber: drafted('120/2026') },
        cluster: 'sparta/Δημοτικό Συμβούλιο', tags: ['sparta'],
    };
    const newId = 'decisions.reading/9ΑΒΓΩ1-ΧΨΖ';
    const candidates: Candidate[] = [
        { id: 'c-1', suite: 'decisions.reading', source: 'disagreement', signal: 'disagreement:run-1', traceId: 'trace-1', caseId: existing.id, proposed: { meetingDate: '2026-07-19', decisionNumber: '121/2026' }, createdAt: '2026-10-10T00:00:00Z' },
        { id: 'c-2', suite: 'decisions.reading', source: 'monitoring', signal: 'check:not_a_decision_with_number', traceId: 'trace-1', caseId: newId, proposed: { meetingDate: '2026-08-01' }, createdAt: '2026-10-10T00:00:00Z', newCase: { input: { ada: '9ΑΒΓΩ1-ΧΨΖ', pdfUrl: 'https://diavgeia.gov.gr/doc/9ΑΒΓΩ1-ΧΨΖ' }, cluster: 'sparta/Δημοτικό Συμβούλιο', tags: ['sparta'] } },
    ];

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
        // Not `dir`: a regression that ignores casesRoot must still miss the case, and land in a temp dir, never in the tracked evals/cases.
        vi.spyOn(process, 'cwd').mockReturnValue(path.join(dir, 'elsewhere'));
        casesRoot = path.join(dir, 'evals', 'cases');
        store = fsStore(path.join(dir, 'archive'));
        writeCase(existing, casesRoot);
        await store.put(archiveKeys.blob(PDF_SHA), PDF);
        await archiveRun(store, 'trace-1', [readingCall('trace-1')]);
    });
    afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

    it('builds, serves the archived PDF, takes the results and applies them as adjudicated values', async () => {
        const batch = await buildBatch('label-confirm', candidates, { store, casesRoot, name: 'sparta', now: new Date('2026-10-11T09:00:00Z') });
        expect(batch).toMatchObject({ kind: 'label-confirm', suite: 'decisions.reading', status: 'open' });
        expect(batch.id).toMatch(/^rv-2026-10-11-sparta-[0-9a-f]{4}$/);
        expect(batch.items.map(i => [i.caseId, i.field, i.proposed])).toEqual([
            [existing.id, 'meetingDate', '2026-07-19'],
            [existing.id, 'decisionNumber', '121/2026'],
            [newId, 'meetingDate', '2026-08-01'],
        ]);
        expect(batch.items[0].evidence.pdf).toEqual({ url: existing.input && (existing.input as { pdfUrl: string }).pdfUrl, sha256: PDF_SHA, page: 1 });

        const page = renderPage(batch);
        expect(page).toContain(batch.id);
        expect(page).toContain('0 / 3');
        await saveBatch(store, batch, page);

        const server = await serveBatch(store, batch.id);
        try {
            expect(await (await fetch(server.url)).text()).toBe(page);
            const src = await fetch(`${server.url}api/items/${encodeURIComponent(batch.items[0].id)}/source`);
            expect(src.headers.get('content-type')).toBe('application/pdf');
            expect(Buffer.from(await src.arrayBuffer())).toEqual(PDF);

            const results: ReviewResults = {
                batchId: batch.id, reviewer: 'andreas', submittedAt: '2026-10-11T09:05:00.000Z',
                results: [
                    { itemId: batch.items[0].id, decision: 'confirm' },
                    { itemId: batch.items[1].id, decision: 'correct', value: '122/2026' },
                    { itemId: batch.items[2].id, decision: 'cant-tell', note: 'page 1 is cut off' },
                ],
            };
            const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
                fetch(`${server.url}api/results`, { method: 'POST', headers, body: JSON.stringify(body) });
            // Another page open in the browser must not be able to submit for the reviewer.
            expect((await post(results, { 'content-type': 'text/plain' })).status).toBe(415);
            expect((await post(results, { 'content-type': 'application/json', origin: 'http://evil.example' })).status).toBe(403);
            const partial = await post({ ...results, results: results.results.slice(0, 2) });
            expect(partial.status).toBe(422);
            const ok = await post(results);
            expect(await ok.json()).toEqual({ ok: true, status: 'submitted' });
        } finally {
            await server.close();
        }

        const out = await applyBatch(store, batch.id, { casesRoot, registryRoot: dir, now: new Date('2026-10-11T09:10:00Z') });
        expect(out.issues).toEqual([]);
        expect(out.batch.history.map(h => h.status)).toEqual(['open', 'submitted', 'applied']);
        expect((await loadBatch(store, batch.id)).status).toBe('applied');

        const updated = readCase(existing.id, casesRoot)!;
        expect(updated.split).toBe('dev');
        expect(updated.expect.meetingDate).toEqual({ value: '2026-07-19', tier: 'adjudicated', by: 'andreas', at: '2026-10-11', source: `review:${batch.id}` });
        expect(updated.expect.decisionNumber).toMatchObject({ value: '122/2026', tier: 'adjudicated' });
        expect(updated.history).toEqual([
            { at: '2026-10-11', change: 'meetingDate drafted→adjudicated', batch: batch.id },
            { at: '2026-10-11', change: 'decisionNumber drafted→adjudicated (corrected)', batch: batch.id },
        ]);

        const created = readCase(newId, casesRoot)!;
        expect(created.split).toBe(assignSplit(newId));
        expect(created.cluster).toBe('sparta/Δημοτικό Συμβούλιο');
        expect(created.expect.meetingDate).toMatchObject({ value: '2026-08-01', tier: 'contested', reason: `can't tell in review ${batch.id}: page 1 is cut off` });

        expect(lintCases(casesRoot)).toEqual([]);
        expect(out.prBody).toContain('reviewed by **andreas**');
        await expect(applyBatch(store, batch.id, { casesRoot, registryRoot: dir })).rejects.toThrow(/already applied/);
    });

    it('shows the document of the call that produced the value, not the run\'s first', async () => {
        const OTHER_SHA = 'cd'.repeat(32);
        const first = readingCall('trace-2');
        const other: CallRecord = { ...first, callId: 'call-other', request: { ...first.request, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'blob', sha256: OTHER_SHA, media_type: 'application/pdf', bytes: 1 } }] }] } };
        await archiveRun(store, 'trace-2', [first, other]);
        const cand = { ...candidates[0], traceId: 'trace-2', proposed: { meetingDate: '2026-07-19' } };
        const [named] = (await buildBatch('label-confirm', [{ ...cand, callId: 'call-other' }], { store, casesRoot })).items;
        expect(named.evidence).toMatchObject({ callId: 'call-other', pdf: { sha256: OTHER_SHA } });
        const [unnamed] = (await buildBatch('label-confirm', [cand], { store, casesRoot })).items;
        expect(unnamed.evidence.pdf?.sha256).toBe(PDF_SHA);
        expect(unnamed.evidence.callId).toBeUndefined();
    });

    it('holds one item per case field when two candidates propose it, so the batch applies', async () => {
        const second: Candidate = { ...candidates[0], id: 'c-3', signal: 'disagreement:run-2', proposed: { meetingDate: '2026-07-21' } };
        const batch = await buildBatch('label-confirm', [candidates[0], second], { store, casesRoot });
        expect(batch.items.map(i => [i.candidateId, i.field])).toEqual([['c-1', 'meetingDate'], ['c-1', 'decisionNumber']]);
        await saveBatch(store, batch, renderPage(batch));
        await submitResults(store, batch, { batchId: batch.id, reviewer: 'andreas', submittedAt: '2026-10-11T09:05:00.000Z', results: batch.items.map(i => ({ itemId: i.id, decision: 'confirm' })) });
        const out = await applyBatch(store, batch.id, { casesRoot, registryRoot: dir });
        expect(out.batch.status).toBe('applied');
        expect(readCase(existing.id, casesRoot)!.expect.meetingDate.value).toBe('2026-07-19');
    });

    it('puts the files back when lint fails, so the batch applies once the issue is fixed', async () => {
        const batch = await buildBatch('label-confirm', candidates, { store, casesRoot });
        await saveBatch(store, batch, renderPage(batch));
        await submitResults(store, batch, { batchId: batch.id, reviewer: 'andreas', submittedAt: '2026-10-11T09:05:00.000Z', results: batch.items.map(i => ({ itemId: i.id, decision: 'confirm' })) });
        const broken = path.join(casesRoot, 'decisions.reading', 'broken.json');
        fs.writeFileSync(broken, '{');

        const first = await applyBatch(store, batch.id, { casesRoot, registryRoot: dir });
        expect(first.issues.map(i => i.rule)).toEqual(['parse']);
        expect(first.batch.status).toBe('submitted');
        expect(readCase(existing.id, casesRoot)).toEqual(existing);
        expect(readCase(newId, casesRoot)).toBeNull();

        fs.rmSync(broken);
        const second = await applyBatch(store, batch.id, { casesRoot, registryRoot: dir });
        expect(second.batch.status).toBe('applied');
        expect(readCase(existing.id, casesRoot)!.expect.meetingDate.value).toBe('2026-07-19');
    });

    it('puts the files back when the archive fails to record the batch as applied, so a retry applies', async () => {
        const batch = await buildBatch('label-confirm', candidates, { store, casesRoot });
        await saveBatch(store, batch, renderPage(batch));
        await submitResults(store, batch, { batchId: batch.id, reviewer: 'andreas', submittedAt: '2026-10-11T09:05:00.000Z', results: batch.items.map(i => ({ itemId: i.id, decision: 'confirm' })) });
        const batchKey = archiveKeys.review(batch.id, 'batch.json');
        const failing: ArchiveStore = { ...store, put: (key, ...rest) => key === batchKey ? Promise.reject(new Error('archive down')) : store.put(key, ...rest) };

        await expect(applyBatch(failing, batch.id, { casesRoot, registryRoot: dir })).rejects.toThrow('archive down');
        expect((await loadBatch(store, batch.id)).status).toBe('submitted');
        expect(readCase(existing.id, casesRoot)).toEqual(existing);
        expect(readCase(newId, casesRoot)).toBeNull();

        const retry = await applyBatch(store, batch.id, { casesRoot, registryRoot: dir });
        expect(retry.batch.status).toBe('applied');
        expect(readCase(existing.id, casesRoot)!.expect.meetingDate.value).toBe('2026-07-19');
    });

    it('refuses to apply a batch nobody submitted, and a stale one', async () => {
        const batch = await buildBatch('label-confirm', candidates.slice(0, 1), { store, casesRoot });
        await saveBatch(store, batch, renderPage(batch));
        await expect(applyBatch(store, batch.id, { casesRoot, registryRoot: dir })).rejects.toThrow(/is open: a person submits it first/);

        writeCase({ ...existing, expect: { ...existing.expect, meetingDate: drafted('2026-07-20') } }, casesRoot);
        const results: ReviewResults = { batchId: batch.id, reviewer: 'andreas', submittedAt: '2026-10-11T09:05:00.000Z', results: batch.items.map(i => ({ itemId: i.id, decision: 'confirm' })) };
        expect(() => planApply(batch, results, { casesRoot })).toThrow(/changed since batch/);
    });
});

describe('label-confirm apply against the private and committed case roots', () => {
    let dir: string;
    const c: Case = { id: 'decisions.matching/m1', suite: 'decisions.matching', split: 'dev', input: { secret: 'production text' }, expect: { link: drafted('A') }, cluster: 'x', tags: [] };
    const batch = (current: ReviewBatch['items'][number]['current'], field = 'link'): ReviewBatch => ({
        id: 'rv-p', kind: 'label-confirm', suite: c.suite, createdBy: 'agent', createdAt: '', status: 'submitted', history: [],
        items: [{ id: 'i1', caseId: c.id, field, proposed: 'B', current, evidence: {} }],
    });
    const results = (decision: 'confirm' | 'cant-tell'): ReviewResults => ({ batchId: 'rv-p', reviewer: 'bob', submittedAt: '2026-10-11T09:00:00.000Z', results: [{ itemId: 'i1', decision }] });
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-roots-'));
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
    });
    afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

    it('writes a private case back to the private root', () => {
        const privateRoot = path.join(dir, '.eval-signals', 'cases');
        writeCase(c, privateRoot);
        const files = writePlan(planApply(batch(c.expect.link), results('confirm')));
        expect(files).toEqual([path.join(privateRoot, c.suite, 'm1.json')]);
        expect(fs.existsSync(path.join(dir, 'evals'))).toBe(false);
        expect(readCase(c.id, privateRoot)!.expect.link).toMatchObject({ value: 'B', tier: 'adjudicated' });
    });

    it('refuses a batch built while a field was empty that a person has settled since', () => {
        const root = path.join(dir, 'evals', 'cases');
        writeCase({ ...c, expect: { ...c.expect, other: { ...drafted('right'), tier: 'adjudicated', by: 'maria' } } }, root);
        expect(() => planApply(batch(null, 'other'), results('cant-tell'), { casesRoot: root })).toThrow(/changed since batch/);
        writeCase({ ...c, expect: { ...c.expect, other: drafted('later') } }, root);
        expect(planApply(batch(null, 'other'), results('confirm'), { casesRoot: root }).cases[0].case.expect.other).toMatchObject({ value: 'B', tier: 'adjudicated' });
    });
});

describe('mode-examples review', () => {
    let dir: string;
    let store: ArchiveStore;
    const casesDir = (root: string) => path.join(root, 'evals', 'failure-modes', 'FM-0042-test-mode', 'detector-cases');
    const contextCall = (callId: string, text: string): CallRecord => ({
        v: 1, callId, traceId: 'trace-m', label: `subject-context-search:${callId}`, cacheKey: 'k', startedAt: '', finishedAt: '',
        request: { model: 'claude-sonnet-4-5', max_tokens: 64000, system: { hash: 'h' }, messages: [{ role: 'user', content: 'long prompt' }] },
        response: { servedModel: 'claude-sonnet-4-5', stopReason: 'end_turn', text, usage: {}, latencyMs: 1, batchMode: false },
    });

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modes-'));
        store = fsStore(path.join(dir, 'archive'));
        fs.mkdirSync(casesDir(dir), { recursive: true });
        fs.writeFileSync(path.join(dir, 'evals', 'failure-modes', 'FM-0042-test-mode.yaml'), 'id: FM-0042\nslug: test_mode\ntitle: Test mode\ndefinition: Opens with a disclaimer.\nboundary: Not a late disclaimer.\nsuite: summarize.context\nscope: call\nseverity: minor\nimpact: visible\nstatus: candidate\n');
        fs.writeFileSync(path.join(casesDir(dir), 'must-fire-2-seed.json'), JSON.stringify({ kind: 'must-fire', input: {} }));
        await archiveRun(store, 'trace-m', [contextCall('a', 'Δυστυχώς δεν βρέθηκαν…'), contextCall('b', 'Το θέμα αφορά…'), contextCall('c', 'Ίσως…')]);
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('keeps confirmed occurrences as must-fire cases and rejected ones as known false alarms', async () => {
        const cand = (callId: string): Candidate => ({ id: `c-${callId}`, suite: 'summarize.context', source: 'monitoring', signal: 'check:test_mode', traceId: 'trace-m', callId, modeId: 'FM-0042', createdAt: '2026-10-11T00:00:00Z', evidence: 'Δυστυχώς' });
        const batch = await buildBatch('mode-examples', ['a', 'b', 'c'].map(cand), { store, registryRoot: dir });
        expect(batch.modeId).toBe('FM-0042');
        expect(batch.items[0].evidence.call).toEqual({
            traceId: 'trace-m', callId: 'a', label: 'subject-context-search:a',
            request: { model: 'claude-sonnet-4-5', max_tokens: 64000, messages: [{ role: 'user', content: 'long prompt' }] },
            response: { text: 'Δυστυχώς δεν βρέθηκαν…', stopReason: 'end_turn', servedModel: 'claude-sonnet-4-5' },
        });
        await saveBatch(store, batch, renderPage(batch));
        await submitResults(store, batch, {
            batchId: batch.id, reviewer: 'andreas', submittedAt: '2026-10-11T10:00:00.000Z',
            results: [{ itemId: 'c-a', decision: 'confirm' }, { itemId: 'c-b', decision: 'reject', note: 'clean' }, { itemId: 'c-c', decision: 'cant-tell' }],
        });

        const out = await applyBatch(store, batch.id, { registryRoot: dir, casesRoot: path.join(dir, 'evals', 'cases') });
        expect(out.issues).toEqual([]);
        expect(out.files.map(f => path.basename(f))).toEqual([`must-fire-3-${batch.id}.json`, `known-false-alarm-1-${batch.id}.json`]);
        const fired = JSON.parse(fs.readFileSync(out.files[0], 'utf8'));
        expect(fired).toMatchObject({ kind: 'must-fire', input: batch.items[0].evidence.call });
        expect(fired.note).toBe(`confirmed as an occurrence in review ${batch.id} by andreas (trace trace-m, subject-context-search:a)`);
        expect(out.batch.status).toBe('applied');
    });

    it('refuses candidates of different modes', async () => {
        const c1: Candidate = { id: 'c1', suite: 's', source: 'monitoring', signal: 'check:x', traceId: 't', callId: 'a', modeId: 'FM-0001', createdAt: '' };
        await expect(buildBatch('mode-examples', [c1, { ...c1, id: 'c2', modeId: 'FM-0002' }], { store, registryRoot: dir })).rejects.toThrow(/one failure mode/);
    });
});

describe('mode-examples review of FM-0011 output_truncated', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm11-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('turns a confirmed occurrence into a detector case the detector still fires on', async () => {
        const store = fsStore(path.join(dir, 'archive'));
        const cut: CallRecord = {
            v: 1, callId: 'x', traceId: 'trace-t', label: 'decision-extraction', cacheKey: 'k', startedAt: '', finishedAt: '',
            request: { model: 'claude-sonnet-4-5', max_tokens: 8000, messages: [{ role: 'user', content: 'extract' }], output_config: { format: { type: 'json_schema', schema: { hash: 'h' } } } },
            response: { servedModel: 'claude-sonnet-4-5', stopReason: 'max_tokens', text: '{"votes":[', usage: {}, latencyMs: 1, batchMode: false },
        };
        await archiveRun(store, 'trace-t', [cut]);
        const cand: Candidate = { id: 'c-x', suite: 'decisions.extraction', source: 'monitoring', signal: 'check:output_truncated', traceId: 'trace-t', callId: 'x', modeId: 'FM-0011', createdAt: '2026-10-11T00:00:00Z', evidence: 'structured output hit max_tokens' };
        // The repository's own registry, only read: the plan is checked, not written.
        const batch = await buildBatch('mode-examples', [cand], { store, registryRoot: repoRoot() });
        const results: ReviewResults = { batchId: batch.id, reviewer: 'andreas', submittedAt: '2026-10-11T10:00:00.000Z', results: [{ itemId: 'c-x', decision: 'confirm' }] };
        const [written] = planApply(batch, results, { registryRoot: repoRoot() }).detectorCases;

        const mode = loadModes().find(m => m.id === 'FM-0011')!;
        const [outcome] = await runDetectorCases(mode, [written.body]);
        expect(outcome).toMatchObject({ ok: true, got: { result: 'fail' } });
    });
});

describe('results validation', () => {
    const batch: ReviewBatch = {
        id: 'rv-x', kind: 'mode-examples', suite: 's', createdBy: 'agent', createdAt: '', status: 'open', history: [],
        items: [{ id: 'i1', evidence: {} }, { id: 'i2', evidence: {} }],
    };

    it('names every problem', () => {
        expect(resultsErrors(batch, { batchId: 'rv-y', reviewer: '', results: [{ itemId: 'i1', decision: 'a', note: { o: 1 } }, { itemId: 'zz', decision: 'confirm' }, null] })).toEqual([
            'batchId is "rv-y", expected rv-x',
            'reviewer must name the person who reviewed',
            'submittedAt is undefined, expected an ISO timestamp',
            'item i1: decision "a" is not one of confirm|reject|cant-tell',
            'item i1: note must be a string',
            'unknown item zz',
            'results[2] must be an object',
            "1 item(s) undecided: i2 (use can't tell)",
        ]);
    });

    it('never resubmits an applied batch', async () => {
        await expect(submitResults(fsStore(os.tmpdir()), { ...batch, status: 'applied' }, {})).rejects.toThrow(/already applied/);
    });
});

describe('disagreement page', () => {
    it('is blind: no tiers, sources or the a/b mapping reach the page', () => {
        const item = { id: 'c-1:meetingDate', caseId: 'decisions.reading/A', field: 'meetingDate', current: drafted('2026-07-18'), evidence: { check: 'meetingDate: drafted disagree' }, ...blindOptions('seed', '2026-07-18', '2026-07-19') };
        const batch: ReviewBatch = { id: 'rv-d', kind: 'disagreement', suite: 'decisions.reading', createdBy: 'agent', createdAt: '', status: 'open', history: [], items: [item] };
        const page = renderPage(batch);
        for (const leak of ['"hidden"', 'cross-model:agree', 'drafted', '"expected"', '"output"']) expect(page).not.toContain(leak);
        expect(page).toContain('2026-07-18');
        expect(page).toContain('2026-07-19');
    });

    it("serves the producing call without its response, which holds one of the two values", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-blind-'));
        const store = fsStore(path.join(dir, 'archive'));
        try {
            await archiveRun(store, 'trace-d', [readingCall('trace-d')]);
            const item = { id: 'c-1:meetingDate', caseId: 'decisions.reading/A', field: 'meetingDate', current: drafted('2026-07-18'), evidence: { traceId: 'trace-d' }, ...blindOptions('seed', '2026-07-18', '2026-07-19') };
            const batch: ReviewBatch = { id: 'rv-d', kind: 'disagreement', suite: 'decisions.reading', createdBy: 'agent', createdAt: '', status: 'open', history: [], items: [item] };
            await saveBatch(store, batch, renderPage(batch));
            const server = await serveBatch(store, batch.id);
            try {
                const res = await fetch(`${server.url}api/items/${encodeURIComponent(item.id)}/source`);
                expect(res.headers.get('x-content-type-options')).toBe('nosniff');
                const call = await res.json();
                expect(call.request).toBeDefined();
                expect(call.response).toBeUndefined();
            } finally {
                await server.close();
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('orders a/b from the seed, both ways across seeds', () => {
        expect(blindOptions('s1', 'E', 'O')).toEqual(blindOptions('s1', 'E', 'O'));
        const firsts = new Set(Array.from({ length: 20 }, (_, i) => blindOptions(`s${i}`, 'E', 'O').hidden!.a));
        expect(firsts).toEqual(new Set(['expected', 'output']));
    });
});

describe('pairwise review of two summarize.contributions runs', () => {
    let dir: string;
    let casesRoot: string;
    let runsDir: string;
    let store: ArchiveStore;
    const trace = 'a'.repeat(32);
    const said = (speakerName: string, text: string) => ({ speakerId: null, speakerName, text, order: 0 });
    const output = (said2: string) => makeRun('t', [
        makeSubject({ id: 's1', name: 'Θέμα ένα', agendaItemIndex: 1, speakerContributions: [said('Δήμαρχος', 'Είπε το ίδιο.')] }),
        makeSubject({ id: 's2', name: 'Θέμα δύο', agendaItemIndex: 2, speakerContributions: [said('Δήμαρχος', `Είπε κάτι (${said2}).`)] }),
    ]).result;

    function writeRun(runId: string, variant: string, text: string) {
        const d = path.join(runsDir, 'summarize.contributions', runId);
        fs.mkdirSync(d, { recursive: true });
        const manifest: RunManifest = { runId, suite: 'summarize.contributions', variant: { name: variant, overrides: {} }, split: 'all', reps: 1, cases: 1, caseSetSha: 's', gitRef: 'g', gitDirty: false, startedAt: 't', spentUsd: 0, status: 'complete' };
        const row: ResultRow = { caseId: 'summarize.contributions/samothraki-oct5_2026', rep: 0, fields: {}, checks: {}, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0, latencyMs: 0, servedModels: [], status: 'ok', traceId: '', output: output(text) };
        fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(d, 'results.jsonl'), JSON.stringify(row) + '\n');
    }

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairwise-'));
        casesRoot = path.join(dir, 'evals', 'cases');
        runsDir = path.join(dir, 'runs');
        store = fsStore(path.join(dir, 'archive'));
        const contributionsCall: CallRecord = { ...readingCall(trace), callId: 'call-c2', label: 'contributions:Θέμα δύο' };
        const run = { traceId: trace, taskType: 'summarize', taskVersion: 6, taskId: 'x', env: 'development' as const, meeting: 'samothraki/oct5_2026', input: {}, startedAt: '2026-10-10T10:00:00.000Z' };
        const key = archiveKeys.calls('development', new Date(run.startedAt), 'summarize', trace);
        await store.put(key, encodeRunFile({ run, phases: [], calls: [contributionsCall] }, { status: 'success', endedAt: run.startedAt, result: output('recorded') }));
        await store.put(archiveKeys.traceIndex(trace), key);
        writeCase(summarizeContributions.caseFromRun!((await readArchivedRun(trace, store))!), casesRoot);
        writeRun('run-prod', 'production', 'πρώτη εκδοχή');
        writeRun('run-sonnet', 'contributions-sonnet-5-5', 'δεύτερη εκδοχή');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('builds a blind batch of the differing subjects and archives preferences on apply', async () => {
        const batch = await buildPairwiseBatch('summarize.contributions', ['run-prod', 'run-sonnet'], { store, casesRoot, runsDir, now: new Date('2026-10-11T00:00:00Z') });
        expect(batch.items).toHaveLength(1);
        const [item] = batch.items;
        expect(item).toMatchObject({ caseId: 'summarize.contributions/samothraki-oct5_2026', field: 'subject[#2 Θέμα δύο]', evidence: { traceId: trace, callId: 'call-c2' } });
        expect(batch.runs).toMatchObject({ baseline: { variant: 'production' }, candidate: { variant: 'contributions-sonnet-5-5' } });

        const page = renderPage(batch);
        expect(page).toContain('Comparing: <b>production</b> vs <b>contributions-sonnet-5-5</b> · sides hidden and shuffled per item');
        // Named once, in the header: nowhere an item could tie a variant to a side.
        expect(page.split('contributions-sonnet-5-5')).toHaveLength(2);
        expect(page).not.toContain('run-prod');
        expect(page).not.toContain('run-sonnet');
        expect(page).toContain('Είπε κάτι (πρώτη εκδοχή)');
        expect(page).not.toContain('"sides"');
        expect(page).not.toContain('"role"');

        await saveBatch(store, batch, page);
        const candidateKey = item.sides!.a.role === 'candidate' ? 'a' : 'b';
        await submitResults(store, batch, { batchId: batch.id, reviewer: 'Andreas', submittedAt: '2026-10-11T01:00:00Z', results: [{ itemId: item.id, decision: candidateKey }] });
        const out = await applyBatch(store, batch.id, { casesRoot });
        expect(out.batch.status).toBe('applied');
        expect(out.files).toEqual([]);
        const archived = (await store.get(archiveKeys.preferences('summarize.contributions', batch.id)))!.toString('utf8').trim().split('\n').map(l => JSON.parse(l) as PreferenceRecord);
        expect(archived).toEqual([expect.objectContaining({ preferred: 'candidate', reviewer: 'Andreas', field: 'subject[#2 Θέμα δύο]', candidate: expect.objectContaining({ runId: 'run-sonnet' }) })]);
    });
});
