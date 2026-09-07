import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { FusionArm, ProviderId } from "./types.js";

/**
 * One trace per fusion attempt. It is the only durable evidence of what a
 * number came from, so it records identity, not prose: which model, which
 * parameters, which raw response, how long each part took, and what the outcome
 * was.
 *
 * Two rules it must never break:
 *  - No secrets. Keys and tokens are never part of a component record.
 *  - No transcript text in *file names*. Text inside a trace is fine (that is
 *    the point of it), but traces live outside the repo under FUSION_TRACE_DIR
 *    and never enter git — same PII category as the 2026-07-21 purge.
 */

export interface TraceComponent {
    providerId: ProviderId;
    model: string;
    paramsSha: string;
    schemaRev: string;
    rawSha256: string;
    wordCount: number;
    elapsedMs: number;
    cacheHit: boolean;
    error?: string;
}

export interface FusionTrace {
    schema: "oc-fusion-trace/1";
    requestId: string;
    createdAt: string;
    audioSha256: string;
    arm: FusionArm | "scribe";
    mode: string;
    configSha: string;
    components: TraceComponent[];
    timings: {
        totalMs: number;
        pythonMs?: number;
    };
    outcome: "fused" | "scribe-fallback" | "scribe-only" | "failed";
    fallbackReason?: string;
    /**
     * The engine error's message, not just its category. A production fallback
     * whose cause is only a word like "timing_invariant" cannot be diagnosed
     * from the trace, which is the one artifact that survives the request.
     */
    fallbackDetail?: string;
    timingEstimatedRate?: number;
    fusionConfig?: Record<string, unknown>;
    pythonStderrTail?: string;
}

export interface ShadowEvent {
    schema: "oc-fusion-shadow/1";
    requestId: string;
    createdAt: string;
    audioSha256: string;
    status: "scheduled" | "completed" | "failed" | "dropped_capacity";
    detail?: string;
}

export class TraceWriter {
    constructor(private readonly dir: string) { }

    /**
     * Returns false instead of throwing. A trace is evidence about a
     * transcription, not part of it — failing a segment because a log file
     * could not be written would trade a real product for a record of it.
     */
    async write(trace: FusionTrace): Promise<boolean> {
        const name = `${trace.audioSha256}.${trace.arm}.${trace.requestId}.json`;
        return this.writeJson(name, trace);
    }

    async writeShadowEvent(event: ShadowEvent): Promise<boolean> {
        return this.writeJson(path.join("shadow", `${event.requestId}.${event.status}.json`), event);
    }

    private async writeJson(relative: string, value: unknown): Promise<boolean> {
        const file = path.join(this.dir, relative);
        try {
            await fsp.mkdir(path.dirname(file), { recursive: true });
            const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
            await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
            await fsp.rename(tmp, file);
            return true;
        } catch (error) {
            console.warn(`[fusion] trace write failed (${relative}): ${error}`);
            return false;
        }
    }
}
