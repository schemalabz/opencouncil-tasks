import { randomUUID } from 'node:crypto';
import type { CallRecord } from '../lib/llm/callRecord.js';
import { DEFAULT_POLICY, runWithCallPolicy, type CallPolicy } from '../lib/llm/callPolicy.js';
import { getRunState, type RunEnv, type RunInfo, type RunState } from '../lib/telemetry/context.js';
import { runWithTelemetry } from '../lib/telemetry/telemetry.js';
import type { TaskName } from '../tasks/registry.js';
import type { Task } from '../tasks/pipeline.js';
import { callsCostUsd } from '../lib/pricing.js';

export { callsCostUsd as liveCost };

export type TaskRunOptions = {
    env: RunEnv;
    policy?: Partial<CallPolicy>;
    meeting?: string;
    eval?: RunInfo['eval'];
    onProgress?: (stage: string, percent: number) => void;
};

type AnyTasks = Record<string, { task: Task<unknown, unknown>; metadata: { version?: number } }>;

// Errors raised by the call policy rather than the model. Tasks that handle documents one
// at a time catch per-item failures and still succeed, which would turn a replay miss or a
// spent budget into a quietly degraded result that then gets scored.
const POLICY_ERRORS = new Set(['ReplayMissError', 'BudgetExceededError', 'UnpricedModelError']);

export function policyFailures(calls: CallRecord[]): CallRecord[] {
    return calls.filter(c => c.error && POLICY_ERRORS.has(c.error.class));
}

export class PolicyErrorsInRunError extends Error {
    constructor(public readonly traceId: string, failed: CallRecord[], total: number) {
        super(`${failed.length} of ${total} calls failed under the call policy (run ${traceId}); first: ${failed[0].error!.message}`);
        this.name = 'PolicyErrorsInRunError';
    }
}

export type TaskRunResult = { traceId: string; result: unknown; calls: CallRecord[]; costUsd: number; liveCalls: number };

// Loaded on first use: the registry imports every task module, which callers that inject tasks never need.
async function registeredTasks(): Promise<AnyTasks> {
    return (await import('../tasks/registry.js')).TASKS as unknown as AnyTasks;
}

export async function isTaskName(name: string): Promise<boolean> {
    return Object.prototype.hasOwnProperty.call(await registeredTasks(), name);
}

/**
 * Tasks read the city and meeting from the callback URL the app sends (for scoped
 * logging), so a run outside the server gets one in the app's shape that points nowhere.
 */
export function withCallbackUrl(request: unknown, meeting: string | undefined, taskId: string): unknown {
    if (!request || typeof request !== 'object' || 'callbackUrl' in request) return request;
    const [city, meetingId] = (meeting ?? 'eval/unknown').split('/');
    return { ...request, callbackUrl: `http://eval.invalid/api/cities/${city}/meetings/${meetingId}/taskStatuses/${taskId}/` };
}

/**
 * Runs a registered task exactly as the server would, inside one telemetry run and
 * under the given call policy, and returns its result with every call it made.
 */
export async function runTask(name: TaskName, request: unknown, opts: TaskRunOptions, tasks?: AnyTasks): Promise<TaskRunResult> {
    // Requests are only known to be JSON here; the task validates its own input, as on the server.
    const { task, metadata } = (tasks ?? await registeredTasks())[name];
    const policy: CallPolicy = { ...DEFAULT_POLICY, ...opts.policy };
    const taskId = `cli-${randomUUID()}`;
    let state: RunState | undefined;
    // The telemetry run must return the task's own result: that is what gets archived as the run's output.
    const result = await runWithCallPolicy(policy, () => runWithTelemetry({
        taskType: name,
        taskVersion: metadata.version ?? null,
        taskId,
        meeting: opts.meeting,
        env: opts.env,
        input: request,
        eval: opts.eval,
    }, async () => {
        const out = await task(withCallbackUrl(request, opts.meeting, taskId), opts.onProgress ?? (() => {}));
        state = getRunState();
        return out;
    }));
    const calls = [...(state?.calls ?? [])];
    const failed = policyFailures(calls);
    if (failed.length) throw new PolicyErrorsInRunError(state!.run.traceId, failed, calls.length);
    const { usd, live } = callsCostUsd(calls);
    return { traceId: state!.run.traceId, result, calls, costUsd: usd, liveCalls: live };
}
