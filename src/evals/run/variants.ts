import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import type { CallOverrides } from '../../lib/llm/callPolicy.js';
import type { Variant } from '../types.js';

/** "decision-reading.model=claude-haiku-5-5" → { 'decision-reading': { model: 'claude-haiku-5-5' } } */
export function parseOverrides(specs: string[]): Record<string, CallOverrides> {
    const out: Record<string, CallOverrides> = {};
    for (const spec of specs) {
        const m = spec.match(/^(.+)\.(model|effort|maxTokens)=(.+)$/);
        if (!m) throw new Error(`Bad --override "${spec}" (expected <label-glob>.<model|effort|maxTokens>=<value>)`);
        const [, label, field, value] = m;
        const entry = (out[label] ??= {});
        if (field === 'maxTokens') entry.maxTokens = Number(value);
        else if (field === 'effort') entry.effort = value as CallOverrides['effort'];
        else entry.model = value;
    }
    return out;
}

export function variantsRoot(root?: string): string {
    return root ?? path.join(process.cwd(), 'evals', 'variants');
}

/**
 * A named variant from evals/variants/<name>.yaml, or a path to one, with any
 * command-line overrides layered on top (they win, and are recorded in the run).
 */
export function loadVariant(nameOrPath: string, cli: { override?: string[]; params?: Record<string, unknown> } = {}, root?: string): Variant {
    const file = nameOrPath.endsWith('.yaml') ? nameOrPath : path.join(variantsRoot(root), `${nameOrPath}.yaml`);
    const parsed = fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}) as Partial<Variant> : null;
    if (!parsed && !cli.override?.length) throw new Error(`No variant "${nameOrPath}" (looked for ${file})`);
    const extra = parseOverrides(cli.override ?? []);
    const overrides = { ...(parsed?.overrides ?? {}) };
    for (const [label, o] of Object.entries(extra)) overrides[label] = { ...(overrides[label] ?? {}), ...o };
    return {
        name: parsed?.name ?? path.basename(nameOrPath, '.yaml'),
        overrides,
        params: { ...(parsed?.params ?? {}), ...(cli.params ?? {}) },
    };
}
