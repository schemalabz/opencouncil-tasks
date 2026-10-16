import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Case } from '../types.js';
import { casesRoot, writeCase } from './caseStore.js';
import { lintCases } from './lint.js';

const label = (value: unknown, tier = 'adjudicated') => ({ value, tier, by: 'fixture', at: '2026-09-29', source: 'fixture:x@v3' });

function rawCase(stem: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: `s/${stem}`, suite: 's', split: 'dev', input: { ada: stem },
        expect: { meetingDate: label('2026-07-18'), decisionNumber: label(null, 'drafted') },
        cluster: 'city/body', tags: [], ...over,
    };
}

describe('lintCases', () => {
    let root: string;
    const put = (stem: string, raw: unknown, suite = 's') => {
        fs.mkdirSync(path.join(root, suite), { recursive: true });
        fs.writeFileSync(path.join(root, suite, `${stem}.json`), typeof raw === 'string' ? raw : JSON.stringify(raw));
    };
    const rules = () => lintCases(root).map(i => i.rule);

    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('passes a well-formed case', () => {
        put('a', rawCase('a'));
        expect(lintCases(root)).toEqual([]);
    });

    it('flags unparseable files and schema violations', () => {
        put('broken', '{');
        put('b', rawCase('b', { split: 'train', tags: 'x', expect: { f: { tier: 'gold', by: 'x', at: 'y', source: 'z' } } }));
        put('c', rawCase('wrong-stem'));
        const issues = lintCases(root);
        expect(issues.find(i => i.rule === 'parse')?.file).toMatch(/broken\.json$/);
        const messages = issues.filter(i => i.rule === 'schema').map(i => i.message).join('\n');
        expect(messages).toMatch(/split must be dev\|holdout/);
        expect(messages).toMatch(/tags must be an array/);
        expect(messages).toMatch(/expect\.f\.value is required/);
        expect(messages).toMatch(/expect\.f\.tier must be one of/);
        expect(messages).toMatch(/id must be "s\/c"/);
    });

    it('flags an imported value without a signal', () => {
        put('a', rawCase('a', { expect: { meetingDate: label('2026-07-18', 'imported') } }));
        expect(rules()).toEqual(['imported-signal']);
        put('a', rawCase('a', { expect: { meetingDate: { ...label('2026-07-18', 'imported'), signal: 'link:123' } } }));
        expect(rules()).toEqual([]);
    });

    it('flags a duplicate id', () => {
        put('a', rawCase('a'));
        put('b', rawCase('a'));
        expect(rules()).toEqual(['schema', 'unique-id']);
    });
});

describe('lintCases against a git base', () => {
    let repo: string;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    const root = () => path.join(repo, 'evals', 'cases');
    const base: Case = {
        id: 's/91ΙΜΩΨ3-ΤΑ6', suite: 's', split: 'dev', input: {},
        expect: { meetingDate: label('2026-07-18') as Case['expect'][string], decisionNumber: label('1/2026', 'drafted') as Case['expect'][string] },
        cluster: 'city/body', tags: [],
    };

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-git-'));
        git('init', '-q');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        writeCase(base, root());
        git('add', '.');
        git('commit', '-qm', 'cases');
    });
    afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

    it('passes an unchanged tree and new files', () => {
        writeCase({ ...base, id: 's/new', split: 'holdout' }, root());
        expect(lintCases(root(), 'HEAD')).toEqual([]);
    });

    it('flags a changed split', () => {
        writeCase({ ...base, split: 'holdout' }, root());
        expect(lintCases(root(), 'HEAD').map(i => i.rule)).toEqual(['split-immutable']);
    });

    it('flags a tier downgrade unless it carries a reason; an upgrade needs none', () => {
        const downgraded = { ...base, expect: { meetingDate: { ...base.expect.meetingDate, tier: 'drafted' as const }, decisionNumber: { ...base.expect.decisionNumber, tier: 'contested' as const } } };
        writeCase(downgraded, root());
        expect(lintCases(root(), 'HEAD').map(i => i.message)).toEqual([
            'expect.decisionNumber went drafted → contested without a reason',
            'expect.meetingDate went adjudicated → drafted without a reason',
        ]);
        writeCase({ ...downgraded, expect: {
            meetingDate: { ...downgraded.expect.meetingDate, reason: 'reviewer could not tell' },
            decisionNumber: { ...base.expect.decisionNumber, tier: 'adjudicated' },
        } }, root());
        expect(lintCases(root(), 'HEAD')).toEqual([]);
    });

    it('flags a human-tier value deleted outright, and a deleted holdout case', () => {
        const { meetingDate: _gone, ...rest } = base.expect;
        writeCase({ ...base, expect: rest }, root());
        expect(lintCases(root(), 'HEAD').map(i => i.message)).toEqual(['expect.meetingDate (adjudicated) was removed; mark it contested with a reason instead']);

        writeCase(base, root());
        writeCase({ ...base, id: 's/held', split: 'holdout' }, root());
        git('add', '.');
        git('commit', '-qm', 'holdout');
        fs.rmSync(path.join(root(), 's', 'held.json'));
        expect(lintCases(root(), 'HEAD').map(i => i.rule)).toEqual(['holdout-deleted']);
    });

    it('refuses a base that is not a commit', () => {
        expect(() => lintCases(root(), 'no-such-ref')).toThrow(/not a commit/);
    });
});

describe('the committed cases', () => {
    it('lint clean', () => {
        expect(lintCases(casesRoot())).toEqual([]);
    });
});
