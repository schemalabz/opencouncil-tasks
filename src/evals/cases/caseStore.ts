import fs from 'fs';
import path from 'path';
import { canonicalJson, sha256Hex } from '../../lib/llm/cacheKey.js';
import type { Case, Expected, Split } from '../types.js';

export function casesRoot(root?: string): string {
    return root ?? path.resolve(process.cwd(), 'evals', 'cases');
}

/**
 * Cases built from a copy of production data (harvested opencouncil signals). The
 * directory is gitignored: they stay on this machine until someone decides they may
 * be committed. Read beside `evals/cases` whenever no root is given.
 */
export function privateCasesRoot(): string {
    return path.resolve(process.cwd(), '.eval-signals', 'cases');
}

/** The roots a lookup reads: the given one, or the committed and the private case roots. */
export function caseRoots(root?: string): string[] {
    return root ? [root] : [casesRoot(), privateCasesRoot()];
}

/** Case files of one suite, sorted by file name. Empty when the suite has no directory. */
export function caseFiles(suite: string, root?: string): string[] {
    return caseRoots(root).flatMap(r => {
        const dir = path.join(r, suite);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => path.join(dir, f));
    });
}

export function caseStem(file: string): string {
    return path.basename(file, '.json');
}

/** A case in both roots (harvested again after it was committed) is read from the committed one. */
export function loadCases(suite: string, root?: string): Case[] {
    const files = caseFiles(suite, root);
    if (files.length === 0) throw new Error(`No cases for suite "${suite}" under ${caseRoots(root).join(' or ')}`);
    const byId = new Map<string, Case>();
    const shadowed: string[] = [];
    for (const file of files) {
        const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Case;
        const expectedId = `${suite}/${caseStem(file)}`;
        if (c.id !== expectedId) throw new Error(`${file}: id "${c.id}" must be "${expectedId}"`);
        if (byId.has(c.id)) shadowed.push(c.id);
        else byId.set(c.id, c);
    }
    if (shadowed.length) console.warn(`${suite}: ${shadowed.length} case(s) are also in ${privateCasesRoot()}; using the committed copies: ${shadowed.join(', ')}`);
    return [...byId.values()];
}

/** One case by id and the root its file is in, or null when it has no file yet. */
export function locateCase(id: string, root?: string): { case: Case; root: string } | null {
    const suite = id.slice(0, id.indexOf('/'));
    for (const r of caseRoots(root)) {
        const file = path.join(r, suite, `${stemOf({ id, suite })}.json`);
        if (fs.existsSync(file)) return { case: JSON.parse(fs.readFileSync(file, 'utf8')) as Case, root: r };
    }
    return null;
}

/** One case by id, or null when it has no file yet. */
export function readCase(id: string, root?: string): Case | null {
    return locateCase(id, root)?.case ?? null;
}

/** The file stem a case id maps to; the id must be "<suite>/<stem>" with no further slash. */
export function stemOf(c: Pick<Case, 'id' | 'suite'>): string {
    const prefix = `${c.suite}/`;
    if (!c.id.startsWith(prefix)) throw new Error(`Case id "${c.id}" does not start with its suite "${prefix}"`);
    const stem = c.id.slice(prefix.length);
    if (!stem || stem.includes('/') || stem.includes('\\') || stem === '.' || stem === '..') {
        throw new Error(`Case id "${c.id}" has no filesystem-safe stem`);
    }
    return stem;
}

function orderExpected(e: Expected): Expected {
    return { value: e.value, tier: e.tier, by: e.by, at: e.at, source: e.source, signal: e.signal, reason: e.reason };
}

/** Keys in a fixed order so a rewrite of an unchanged case is byte-identical. */
export function serializeCase(c: Case): string {
    const expect: Record<string, Expected> = {};
    for (const key of Object.keys(c.expect).sort()) expect[key] = orderExpected(c.expect[key]);
    const ordered = {
        id: c.id,
        suite: c.suite,
        split: c.split,
        input: c.input,
        replay: c.replay,
        expect,
        cluster: c.cluster,
        tags: c.tags,
        guards: c.guards,
        history: c.history,
    };
    return JSON.stringify(ordered, null, 2) + '\n';
}

export function writeCase(c: Case, root?: string): string {
    const file = path.join(casesRoot(root), c.suite, `${stemOf(c)}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeCase(c));
    return file;
}

/** Deterministic, so a case keeps its split however many times it is regenerated. */
export function assignSplit(caseId: string, ratio = 0.3): Split {
    const fraction = parseInt(sha256Hex(caseId).slice(0, 8), 16) / 0x1_0000_0000;
    return fraction < ratio ? 'holdout' : 'dev';
}

export function caseSetSha(cases: Case[]): string {
    const sorted = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return sha256Hex(canonicalJson(sorted));
}
