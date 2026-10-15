import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { aiChat } from '../../lib/ai.js';
import type { CallRecord } from '../../lib/llm/callRecord.js';
import { repoRoot } from '../registry/registry.js';
import type { FailureMode, JudgeDetector } from '../registry/schema.js';
import { isTaskOutput, unknown, type Check, type CheckResult, type TaskOutput } from './check.js';

type Verdict = { verdict: CheckResult['result']; evidence: string };

const VERDICT_SCHEMA = {
    type: 'object' as const,
    properties: {
        verdict: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
        evidence: { type: 'string' },
    },
    required: ['verdict', 'evidence'],
    additionalProperties: false,
};

/** Deterministic, so a re-run judges the same subset and hits the cache. */
export function sampled(id: string, rate: number): boolean {
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    const bucket = parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16) / 0x100000000;
    return bucket < rate;
}

function systemPrompt(mode: FailureMode, detector: JudgeDetector): string {
    const instructions = fs.readFileSync(path.resolve(repoRoot(), detector.prompt), 'utf8').trim();
    return [
        instructions,
        `## Failure mode: ${mode.slug}\n\n${mode.definition.trim()}`,
        ...(mode.boundary ? [`## Not this failure mode\n\n${mode.boundary.trim()}`] : []),
        'Answer "fail" when the output shows this failure mode, "pass" when it does not, and "unknown" when you cannot tell. Quote the evidence.',
    ].join('\n\n');
}

function userPrompt(x: CallRecord | TaskOutput): string {
    if (!isTaskOutput(x)) return x.response?.text ?? '';
    return JSON.stringify({ task: x.run.taskType, meeting: x.run.meeting, result: x.result }, null, 2);
}

/** One generic LLM judge, configured entirely by the registry entry. */
export function judgeCheck(mode: FailureMode): Check {
    const detector = mode.detector;
    if (detector?.kind !== 'judge') throw new Error(`${mode.id} ${mode.slug} has no judge detector`);
    return {
        id: mode.slug,
        scope: mode.scope,
        appliesTo: x => (mode.scope === 'task' ? isTaskOutput(x) : !isTaskOutput(x) && !!x.response),
        run: async x => {
            const sampleId = isTaskOutput(x) ? x.run.traceId : x.callId;
            if (!sampled(sampleId, detector.sample)) return unknown('not sampled');
            const { result } = await aiChat<Verdict>({
                label: `judge:${mode.slug}`,
                model: detector.model,
                systemPrompt: systemPrompt(mode, detector),
                userPrompt: userPrompt(x),
                outputFormat: { type: 'json_schema', schema: VERDICT_SCHEMA },
                maxTokens: 2048,
                cache: 'use',
            });
            return { result: result.verdict, evidence: result.evidence };
        },
    };
}
