import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { lintRegistry } from './lint.js';
import { loadDetectorCases, loadModes, modesForSuite } from './registry.js';

const entry = (over: Record<string, unknown> = {}) => ({
    id: 'FM-0001', slug: 'some_mode', title: 'A mode', definition: 'What it is.', suite: 'summarize.context', scope: 'call',
    severity: 'minor', impact: 'visible', status: 'candidate', ...over,
});

describe('lintRegistry', () => {
    let root: string;
    const dir = () => path.join(root, 'evals', 'failure-modes');
    const put = (raw: Record<string, unknown> | string, file = `${(raw as any).id}-${String((raw as any).slug).replace(/_/g, '-')}.yaml`) => {
        fs.mkdirSync(dir(), { recursive: true });
        fs.writeFileSync(path.join(dir(), file), typeof raw === 'string' ? raw : YAML.stringify(raw));
    };
    const putCase = (stem: string, name: string, c: unknown) => {
        const d = path.join(dir(), stem, 'detector-cases');
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, `${name}.json`), typeof c === 'string' ? c : JSON.stringify(c));
    };
    const rules = (opts?: { gitBase?: string }) => lintRegistry(root, opts).map(i => i.rule).sort();
    const guarded = (over: Record<string, unknown> = {}) => entry({ status: 'guarded', issue: 'o/r#1', detector: { kind: 'code', module: 'det.ts' }, ...over });

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-lint-'));
        fs.writeFileSync(path.join(root, 'det.ts'), '');
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('passes a well-formed candidate and a guarded mode with both case kinds', () => {
        put(entry());
        put(guarded({ id: 'FM-0002', slug: 'other_mode' }));
        putCase('FM-0002-other-mode', 'a', { kind: 'must-fire', input: {} });
        putCase('FM-0002-other-mode', 'b', { kind: 'must-not-fire', input: {} });
        expect(lintRegistry(root)).toEqual([]);
        expect(loadModes(root).map(m => m.slug)).toEqual(['some_mode', 'other_mode']);
        expect(loadDetectorCases(loadModes(root)[1], root).map(c => c.kind)).toEqual(['must-fire', 'must-not-fire']);
    });

    it('flags unparseable files, missing fields and bad enums', () => {
        put('id: [', 'FM-0003-x.yaml');
        put(entry({ title: '', severity: 'huge', related: [{ type: 'cousin', id: 'FM-0002' }] }));
        expect(rules()).toEqual(['parse', 'schema', 'schema', 'schema']);
    });

    it('enforces id format, uniqueness, slug format and file name', () => {
        put(entry({ id: 'FM-12', slug: 'a_mode' }));
        put(entry({ slug: 'Bad-Slug' }));
        put(entry({ slug: 'dup' }));
        put(entry({ id: 'FM-0004', slug: 'dup' }));
        put(entry({ id: 'FM-0005', slug: 'named_wrong' }), 'FM-0005-other.yaml');
        expect(rules()).toEqual(['file-name', 'id-format', 'id-unique', 'slug-format', 'slug-unique']);
    });

    it('requires an issue from confirmed upward', () => {
        put(entry({ status: 'confirmed' }));
        expect(rules()).toEqual(['issue-required']);
    });

    it('requires a detector and both positive and negative cases when guarded', () => {
        put(guarded({ detector: undefined }));
        putCase('FM-0001-some-mode', 'a', { kind: 'known-miss', input: {} });
        expect(rules()).toEqual(['guarded-evidence', 'guarded-evidence', 'guarded-evidence']);
    });

    it('requires a calibrated judge (n ≥ 30) when guarded', () => {
        fs.writeFileSync(path.join(root, 'p.md'), 'prompt');
        const judge = { kind: 'judge', prompt: 'p.md', model: 'm', sample: 0.2, calibration: { tpr: 0.9, tnr: 0.9, n: 12, at: '2026-10-01' } };
        put(guarded({ status: 'regression', detector: judge }));
        putCase('FM-0001-some-mode', 'a', { kind: 'must-fire', input: {} });
        putCase('FM-0001-some-mode', 'b', { kind: 'must-not-fire', input: {} });
        expect(rules()).toEqual(['judge-calibration']);
    });

    it('requires a successor or reason when retired', () => {
        put(entry({ status: 'retired' }));
        put(entry({ id: 'FM-0002', slug: 'b', status: 'retired', reason: 'merged into the prompt' }));
        expect(rules()).toEqual(['retired-successor']);
    });

    it('flags a missing detector module and malformed detector cases', () => {
        put(entry({ detector: { kind: 'code', module: 'src/nope.ts' } }));
        putCase('FM-0001-some-mode', 'a', { kind: 'should-fire', input: {} });
        putCase('FM-0001-some-mode', 'b', '{');
        expect(rules()).toEqual(['detector-case', 'detector-case', 'detector-missing']);
    });

    it('with a git base, forbids deleting an id or renaming its slug without a renamed relation', () => {
        const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });
        git('init', '-q');
        put(entry());
        put(entry({ id: 'FM-0002', slug: 'doomed' }));
        put(entry({ id: 'FM-0003', slug: 'old_name' }));
        git('add', '.');
        git('commit', '-qm', 'base');

        fs.rmSync(path.join(dir(), 'FM-0002-doomed.yaml'));
        fs.rmSync(path.join(dir(), 'FM-0003-old-name.yaml'));
        put(entry({ id: 'FM-0003', slug: 'new_name' }));
        expect(rules({ gitBase: 'HEAD' })).toEqual(['id-removed', 'slug-renamed']);

        put(entry({ id: 'FM-0003', slug: 'new_name', related: [{ type: 'renamed', id: 'FM-0003' }] }));
        expect(rules({ gitBase: 'HEAD' })).toEqual(['id-removed']);
        expect(() => rules({ gitBase: 'no-such-ref' })).toThrow(/not a commit/);
    });

    it('matches "*" modes to every suite', () => {
        put(entry());
        put(entry({ id: 'FM-0002', slug: 'everywhere', suite: '*' }));
        expect(modesForSuite('decisions.reading', root).map(m => m.slug)).toEqual(['everywhere']);
        expect(modesForSuite('summarize.context', root).map(m => m.slug)).toEqual(['some_mode', 'everywhere']);
    });

    it('shares one mode between the suites it lists', () => {
        put(entry({ suite: ['summarize.context', 'agenda.context'] }));
        expect(rules()).toEqual([]);
        expect(modesForSuite('agenda.context', root).map(m => m.slug)).toEqual(['some_mode']);
        expect(modesForSuite('summarize.context', root).map(m => m.slug)).toEqual(['some_mode']);
        expect(modesForSuite('decisions.reading', root)).toEqual([]);
        put(entry({ suite: [] }));
        expect(rules()).toEqual(['schema']);
    });
});
