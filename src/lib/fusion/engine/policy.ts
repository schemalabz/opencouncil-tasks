/**
 * Load and hash-check the frozen routing policy, ported from `fusion/policy.py`.
 *
 * `policy.json` is a verbatim copy of the research freeze (protocol
 * autoprompt-2026-08-25a): category names, routing modes and Greek instruction
 * text, no transcript text. Its sha256 prefix is checked on load, because a
 * policy that has drifted is not the policy the frozen numbers were measured
 * under. Drift refuses to run rather than quietly producing different output.
 *
 * The LLM wire envelope stays in its own file so `policy.json` can remain byte
 * identical to the research freeze.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

export const POLICY_SHA16 = "3e5676d982078979";

export class PolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PolicyError";
    }
}

export interface PolicyEntry {
    mode: string;
    [key: string]: unknown;
}

export interface LoadedPolicy {
    freeze: Record<string, unknown>;
    policy: Record<string, PolicyEntry>;
    /** Categories routed to the LLM, sorted, as the Python sorts them. */
    llmCategories: string[];
    envelope: Record<string, unknown>;
    envelopeSha16: string;
}

function sha16(b: Buffer): string {
    return crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);
}

/**
 * Python compares strings with `<`, which orders by code point. JavaScript's
 * default sort compares UTF-16 code units, which differs above the BMP, and
 * `localeCompare` is not the same relation at all. Category names are ASCII
 * today; this keeps them ordered the same way if they ever stop being.
 */
function byCodePoint(a: string, b: string): number {
    const ax = [...a];
    const bx = [...b];
    for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
        const d = ax[i].codePointAt(0)! - bx[i].codePointAt(0)!;
        if (d !== 0) return d;
    }
    return ax.length - bx.length;
}

export function loadPolicy(engineDir: string): LoadedPolicy {
    const policyPath = path.join(engineDir, "policy.json");
    const envelopePath = path.join(engineDir, "llm_envelope.json");

    let blob: Buffer;
    try {
        blob = fs.readFileSync(policyPath);
    } catch (e) {
        throw new PolicyError(`policy.json unreadable: ${e}`);
    }
    const got = sha16(blob);
    if (got !== POLICY_SHA16) {
        throw new PolicyError(
            `policy.json sha256[:16] is ${got}, expected ${POLICY_SHA16} — `
            + "the frozen policy has drifted; refusing to run");
    }

    const freeze = JSON.parse(blob.toString("utf8")) as Record<string, unknown>;
    const policy = freeze.policy as Record<string, PolicyEntry>;
    const llmCategories = Object.keys(policy)
        .filter((k) => policy[k].mode === "llm")
        .sort(byCodePoint);

    const envelopeBlob = fs.readFileSync(envelopePath);
    return {
        freeze,
        policy,
        llmCategories,
        envelope: JSON.parse(envelopeBlob.toString("utf8")) as Record<string, unknown>,
        envelopeSha16: sha16(envelopeBlob),
    };
}
