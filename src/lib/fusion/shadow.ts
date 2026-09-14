import crypto from "crypto";
import type { TraceWriter } from "./trace.js";

/**
 * Shadow mode runs fusion *beside* the answer that was already returned. That
 * makes it free to be slow and unfree to be unbounded: a queue of shadow work
 * that grows with the job queue turns a background experiment into an outage.
 *
 * So: one at a time, at most four waiting, and anything beyond that is dropped
 * and recorded as `dropped_capacity`. A dropped shadow run is a missing data
 * point; a shadow backlog is a missing service.
 */

const DEFAULT_CAPACITY = 4;

export interface ShadowJob {
    audioSha256: string;
    run: () => Promise<void>;
}

export class ShadowFusionQueue {
    private readonly pending: ShadowJob[] = [];
    private running = false;
    private idle: Promise<void> = Promise.resolve();
    private resolveIdle?: () => void;

    constructor(private readonly trace: TraceWriter, private readonly capacity = DEFAULT_CAPACITY) { }

    enqueue(job: ShadowJob): "scheduled" | "dropped_capacity" {
        const requestId = crypto.randomUUID();
        if (this.pending.length >= this.capacity) {
            void this.trace.writeShadowEvent({
                schema: "oc-fusion-shadow/1",
                requestId,
                createdAt: new Date().toISOString(),
                audioSha256: job.audioSha256,
                status: "dropped_capacity",
                detail: `queue full (${this.capacity})`,
            });
            return "dropped_capacity";
        }

        void this.trace.writeShadowEvent({
            schema: "oc-fusion-shadow/1",
            requestId,
            createdAt: new Date().toISOString(),
            audioSha256: job.audioSha256,
            status: "scheduled",
        });

        if (!this.running) {
            this.idle = new Promise((resolve) => { this.resolveIdle = resolve; });
        }
        this.pending.push({ ...job, run: () => this.wrap(requestId, job) });
        void this.drain();
        return "scheduled";
    }

    private async wrap(requestId: string, job: ShadowJob): Promise<void> {
        try {
            await job.run();
            await this.trace.writeShadowEvent({
                schema: "oc-fusion-shadow/1",
                requestId,
                createdAt: new Date().toISOString(),
                audioSha256: job.audioSha256,
                status: "completed",
            });
        } catch (error) {
            // A shadow failure is data, never an incident: the caller already
            // has its answer and must never learn that this went wrong.
            await this.trace.writeShadowEvent({
                schema: "oc-fusion-shadow/1",
                requestId,
                createdAt: new Date().toISOString(),
                audioSha256: job.audioSha256,
                status: "failed",
                detail: String(error).slice(0, 500),
            });
        }
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            for (; ;) {
                const job = this.pending.shift();
                if (!job) break;
                await job.run();
            }
        } finally {
            this.running = false;
            this.resolveIdle?.();
            this.resolveIdle = undefined;
        }
    }

    /** Test hook: resolves when the queue has drained. */
    whenIdle(): Promise<void> {
        return this.running || this.pending.length > 0 ? this.idle : Promise.resolve();
    }

    get depth(): number {
        return this.pending.length;
    }
}
