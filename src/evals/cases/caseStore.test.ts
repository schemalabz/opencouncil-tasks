import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Case } from '../types.js';
import { assignSplit, caseSetSha, casesRoot, loadCases, privateCasesRoot, writeCase } from './caseStore.js';

function sampleCase(over: Partial<Case> = {}): Case {
    return {
        id: 'decisions.reading/91ΙΜΩΨ3-ΤΑ6',
        suite: 'decisions.reading',
        split: 'dev',
        input: { ada: '91ΙΜΩΨ3-ΤΑ6', pdfUrl: 'https://diavgeia.gov.gr/doc/91ΙΜΩΨ3-ΤΑ6' },
        expect: {
            meetingDate: { value: '2026-07-18', tier: 'adjudicated', by: 'fixture', at: '2026-09-29', source: 'fixture:x@v3' },
            decisionNumber: { value: null, tier: 'drafted', by: 'fixture', at: '2026-09-29', source: 'fixture:x@v3' },
        },
        cluster: 'argithea/Δημοτική Επιτροπή',
        tags: ['argithea'],
        ...over,
    };
}

describe('loadCases over the committed and private roots', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-'));
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
    });
    afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

    it('reads a case harvested again after it was committed once, from the committed root', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        writeCase(sampleCase({ cluster: 'committed' }), casesRoot());
        writeCase(sampleCase({ cluster: 'harvested again' }), privateCasesRoot());
        writeCase(sampleCase({ id: 'decisions.reading/private-only', cluster: 'private' }), privateCasesRoot());
        expect(loadCases('decisions.reading').map(c => [c.id, c.cluster])).toEqual([
            ['decisions.reading/91ΙΜΩΨ3-ΤΑ6', 'committed'],
            ['decisions.reading/private-only', 'private'],
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
    });
});

describe('case store', () => {
    let root: string;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('writes a Greek-named file with a fixed key order, and reads it back', () => {
        const file = writeCase(sampleCase({ tags: ['b'], cluster: 'c', split: 'holdout' }), root);
        expect(path.basename(file)).toBe('91ΙΜΩΨ3-ΤΑ6.json');
        const text = fs.readFileSync(file, 'utf8');
        expect(text.endsWith('}\n')).toBe(true);
        expect(Object.keys(JSON.parse(text))).toEqual(['id', 'suite', 'split', 'input', 'expect', 'cluster', 'tags']);
        expect(Object.keys(JSON.parse(text).expect)).toEqual(['decisionNumber', 'meetingDate']);
        expect(loadCases('decisions.reading', root)).toEqual([JSON.parse(text)]);
    });

    it('writes byte-identical files however the input object was built', () => {
        const a = sampleCase();
        const b = JSON.parse(JSON.stringify({ tags: a.tags, expect: a.expect, cluster: a.cluster, input: a.input, split: a.split, suite: a.suite, id: a.id })) as Case;
        const first = fs.readFileSync(writeCase(a, root), 'utf8');
        expect(fs.readFileSync(writeCase(b, root), 'utf8')).toBe(first);
        expect(caseSetSha([a])).toBe(caseSetSha([b]));
    });

    it('rejects an id with a slash in its stem or a foreign suite', () => {
        expect(() => writeCase(sampleCase({ id: 'decisions.reading/a/b' }), root)).toThrow(/filesystem-safe/);
        expect(() => writeCase(sampleCase({ id: 'other/a' }), root)).toThrow(/suite/);
    });

    it('refuses a file whose id does not match its name', () => {
        const file = writeCase(sampleCase(), root);
        fs.renameSync(file, path.join(path.dirname(file), 'renamed.json'));
        expect(() => loadCases('decisions.reading', root)).toThrow(/must be "decisions.reading\/renamed"/);
    });

    it('caseSetSha ignores order and sees content', () => {
        const a = sampleCase(), b = sampleCase({ id: 'decisions.reading/x' });
        expect(caseSetSha([a, b])).toBe(caseSetSha([b, a]));
        expect(caseSetSha([a, b])).not.toBe(caseSetSha([a, sampleCase({ id: 'decisions.reading/x', tags: ['y'] })]));
    });
});

describe('assignSplit', () => {
    it('is deterministic and holds out about 30%', () => {
        const ids = Array.from({ length: 2000 }, (_, i) => `suite/case-${i}`);
        expect(ids.map(id => assignSplit(id))).toEqual(ids.map(id => assignSplit(id)));
        const holdout = ids.filter(id => assignSplit(id) === 'holdout').length / ids.length;
        expect(holdout).toBeGreaterThan(0.25);
        expect(holdout).toBeLessThan(0.35);
    });
});
