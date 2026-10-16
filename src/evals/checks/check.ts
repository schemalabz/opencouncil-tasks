import path from 'path';
import { pathToFileURL } from 'url';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import { matchesGlob } from '../../lib/llm/callPolicy.js';
import type { RunInfo } from '../../lib/telemetry/context.js';
import { repoRoot } from '../registry/registry.js';
import type { FailureMode } from '../registry/schema.js';

/** A check "fires" when it returns `fail`. */
export type CheckResult = { result: 'pass' | 'fail' | 'unknown'; evidence?: string };
export type TaskOutput = { run: RunInfo; result: unknown; calls: CallRecord[] };

export interface Check {
    /** = the failure mode's slug */
    id: string;
    scope: 'call' | 'task';
    appliesTo(x: CallRecord | TaskOutput): boolean;
    run(x: CallRecord | TaskOutput): Promise<CheckResult>;
}

export const pass = (evidence?: string): CheckResult => ({ result: 'pass', ...(evidence && { evidence }) });
export const fail = (evidence: string): CheckResult => ({ result: 'fail', evidence });
export const unknown = (evidence: string): CheckResult => ({ result: 'unknown', evidence });

export function isTaskOutput(x: CallRecord | TaskOutput): x is TaskOutput {
    return 'run' in x && 'calls' in x;
}

/**
 * A check over single calls whose label matches one of `labels` ("*" globs allowed).
 * A call without a response (it errored before one arrived) is `unknown`.
 */
export function callCheck(id: string, labels: string[], judge: (call: CallRecord & { response: NonNullable<CallRecord['response']> }) => CheckResult): Check {
    return {
        id,
        scope: 'call',
        appliesTo: x => !isTaskOutput(x) && labels.some(glob => matchesGlob(x.label ?? 'aiChat', glob)),
        run: async x => {
            const call = x as CallRecord;
            return call.response ? judge(call as CallRecord & { response: NonNullable<CallRecord['response']> }) : unknown('the call has no response');
        },
    };
}

/** A check over a whole task output, for the given task types. */
export function taskCheck(id: string, taskTypes: string[], judge: (output: TaskOutput) => CheckResult): Check {
    return {
        id,
        scope: 'task',
        appliesTo: x => isTaskOutput(x) && taskTypes.includes(x.run.taskType),
        run: async x => judge(x as TaskOutput),
    };
}

/** The response text parsed as JSON, or undefined when it is not JSON. */
export function responseJson(call: CallRecord): unknown {
    try {
        return JSON.parse(call.response?.text ?? '');
    } catch {
        return undefined;
    }
}

/** Lowercase, accents and the final sigma folded away, so «Δυστυχώς» and «ΔΥΣΤΥΧΩΣ» compare equal. */
export function foldGreek(text: string): string {
    return text.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC').toLocaleLowerCase('el').replace(/ς/g, 'σ');
}

/**
 * Compiled code runs from dist/, where a `src/….ts` detector path has a `dist/….js` twin.
 */
function detectorModuleUrl(module: string): string {
    const root = repoRoot();
    const compiled = import.meta.url.endsWith('.js') && module.startsWith('src/') && module.endsWith('.ts');
    const file = compiled ? path.join(root, 'dist', module.slice('src/'.length).replace(/\.ts$/, '.js')) : path.resolve(root, module);
    return pathToFileURL(file).href;
}

export async function loadCheck(mode: FailureMode): Promise<Check> {
    const detector = mode.detector;
    if (!detector) throw new Error(`${mode.id} ${mode.slug} has no detector`);
    if (detector.kind === 'judge') {
        const { judgeCheck } = await import('./judge.js');
        return judgeCheck(mode);
    }
    const name = detector.export ?? 'default';
    const mod = await import(detectorModuleUrl(detector.module));
    const check = mod[name] as Check | undefined;
    if (!check || typeof check.run !== 'function' || typeof check.appliesTo !== 'function') {
        throw new Error(`${detector.module} has no Check export "${name}"`);
    }
    if (check.id !== mode.slug) throw new Error(`${detector.module}#${name} has id "${check.id}", expected the slug "${mode.slug}"`);
    if (check.scope !== mode.scope) throw new Error(`${detector.module}#${name} has scope ${check.scope}, the entry says ${mode.scope}`);
    return check;
}
