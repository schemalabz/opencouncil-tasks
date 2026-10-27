import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { lintCases } from '../../cases/lint.js';
import { casesRoot, readCase, writeCase } from '../../cases/caseStore.js';
import { harvestOpencouncil, utteranceEditExpectation, type OpencouncilContext, type OpencouncilSignal } from './opencouncil.js';

const at = '2026-09-02T10:00:00.000Z';
const link = (action: string, ids: Record<string, string | null>): OpencouncilSignal => ({ kind: 'decision-link', action, ids: { cityId: 'demo', meetingId: 'm1', ...ids }, before: null, after: null, by: 'user', at, evidence: 'test' });
const window: OpencouncilContext = {
    kind: 'decision-window', ids: { cityId: 'demo', meetingId: 'm1', taskStatusId: 't' },
    value: {
        meetingDate: '2026-09-01', diavgeiaUid: 'org', administrativeBodyName: 'Δημοτική Επιτροπή', window: { fromDate: '2026-09-01', toDate: '2026-09-15' },
        subjects: [{ subjectId: 's1', name: 'Α', agendaItemIndex: 1, nonAgendaReason: null }, { subjectId: 's2', name: 'Β', agendaItemIndex: 2, nonAgendaReason: null }],
        links: [{ subjectId: 's1', ada: 'A1', byTask: false }, { subjectId: 's2', ada: 'A2', byTask: true }],
    },
};
const signals: (OpencouncilSignal | OpencouncilContext)[] = [
    link('assign', { subjectId: 's1', decisionId: 'd1', ada: 'A1' }),
    link('manual', { subjectId: 's2', decisionId: 'd2', ada: null }),
    link('dismiss', { candidateId: 'c1', ada: 'R1', subjectId: null }),
    { kind: 'utterance-edit', action: 'edit', ids: { cityId: 'demo', meetingId: 'm1', utteranceId: 'u1', taskStatusId: 'f1' }, before: 'λαθος', after: 'λάθος', by: 'user', at, evidence: 'test', taskOutput: null },
    window,
    link('assign', { meetingId: 'm2', subjectId: 's9', decisionId: 'd9', ada: 'A9' }),
];

function signalFile(): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signals-')), 'signals.jsonl');
    fs.writeFileSync(file, signals.map(s => JSON.stringify(s)).join('\n') + '\n');
    return file;
}

describe('harvest --source opencouncil', () => {
    it('writes an imported matching case per meeting window, and says what it could not use', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-'));
        const r = harvestOpencouncil(signalFile(), { root, now: new Date('2026-10-11T00:00:00Z') });
        expect(r.written).toHaveLength(1);
        expect(r.skipped).toEqual([
            'demo/m1: opencouncil:decision-link:manual:d2 links a document with no ΑΔΑ',
            'demo/m2: no decision-window context (export with --contexts)',
        ]);
        expect(Object.values(r.unused)).toEqual([1]);
        const c = readCase('decisions.matching/demo-m1', root)!;
        expect(c.expect['link[s1]']).toMatchObject({ value: 'A1', tier: 'imported', by: 'user', at: '2026-09-02', signal: 'opencouncil:decision-link:assign:d1' });
        expect(c.expect['link[s2]']).toMatchObject({ value: 'A2', tier: 'drafted' });
        expect(c.expect['reject[R1]']).toMatchObject({ value: { subjectId: null }, tier: 'imported' });
        expect((c.input as { links?: unknown }).links).toBeUndefined();
        expect(lintCases(root)).toEqual([]);
    });

    it('keeps a case\'s split when the signals are harvested again', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-'));
        const file = signalFile();
        harvestOpencouncil(file, { root });
        const first = readCase('decisions.matching/demo-m1', root)!;
        writeCase({ ...first, split: first.split === 'dev' ? 'holdout' : 'dev' }, root);
        const again = harvestOpencouncil(file, { root });
        expect(again.updated).toHaveLength(1);
        expect(readCase('decisions.matching/demo-m1', root)!.split).not.toBe(first.split);
    });

    it('keeps a value settled in review when the same signals are harvested again', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-'));
        const file = signalFile();
        harvestOpencouncil(file, { root });
        const c = readCase('decisions.matching/demo-m1', root)!;
        const settled = { value: 'A3', tier: 'adjudicated' as const, by: 'reviewer', at: '2026-10-01', source: 'review:rv-1' };
        writeCase({ ...c, expect: { ...c.expect, 'link[s2]': settled }, history: [{ at: '2026-10-01', change: 'link[s2] drafted→adjudicated (corrected)', batch: 'rv-1' }] }, root);
        harvestOpencouncil(file, { root });
        const again = readCase('decisions.matching/demo-m1', root)!;
        expect(again.expect['link[s2]']).toEqual(settled);
        expect(again.history).toHaveLength(1);
    });

    it('leaves a case alone once it is committed', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
        try {
            const file = signalFile();
            harvestOpencouncil(file);
            fs.cpSync(path.join(dir, '.eval-signals', 'cases'), casesRoot(), { recursive: true });
            fs.rmSync(path.join(dir, '.eval-signals'), { recursive: true });
            const again = harvestOpencouncil(file);
            expect([again.written, again.updated]).toEqual([[], []]);
            expect(again.skipped).toContain(`decisions.matching/demo-m1: already committed under ${casesRoot()}`);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('refuses a suite no signal feeds', () => {
        expect(() => harvestOpencouncil(signalFile(), { suite: 'decisions.reading' })).toThrow(/No opencouncil signals feed/);
    });
});

describe('utteranceEditExpectation', () => {
    it('states the person\'s text against the text fixTranscript was given', () => {
        const edit = signals[3] as OpencouncilSignal;
        expect(utteranceEditExpectation(edit)).toEqual({
            field: 'utterance[u1]',
            expected: { value: { text: 'λάθος', before: 'λαθος' }, tier: 'imported', by: 'user', at: '2026-09-02', source: 'opencouncil:utterance-edit', signal: 'opencouncil:utterance-edit:edit:u1' },
        });
    });
});
