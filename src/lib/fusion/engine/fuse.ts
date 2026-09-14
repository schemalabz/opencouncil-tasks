/**
 * `oc-fusion-in/1` in, `oc-fusion/1` out. Ported from `fusion/fuse.py`.
 *
 * Alignment and island rules live here; provider orchestration, timing and
 * transcript assembly stay where they already are, in the fusion library above
 * this directory.
 *
 * The LLM chooser is deliberately NOT ported. It contributes to no measured
 * result, it is off by default, and an external model's answers cannot be part
 * of a deterministic equivalence proof. A request that asks for it is rejected
 * here with `LlmNotSupportedError` so the caller can route that one path to the
 * Python, rather than being quietly served a different arm.
 *
 * On `text`: one raw provider word can normalize to several tokens, so several
 * consecutive output tokens can carry the same `src`/`src_word` and the same
 * raw `text` while their `norm` differs. A run of tokens sharing
 * `(src, src_word)` is one raw word.
 */
import { align3, bandFor, columnIndices, consensusPivot, type Column } from "./msa.js";
import { chunkConfigFrom, planChunks, type ChunkConfig, type ChunkRanges } from "./chunking.js";
import { columnClass } from "./islands.js";
import { NORMALIZER_REV, tokenizeWords } from "./normalize.js";
import * as R from "./rules.js";
import { type Island, type Triple } from "./rules.js";
import { POLICY_SHA16, type LoadedPolicy } from "./policy.js";
import { pySum } from "./pyjson.js";

export const CODE_REV = "fusion/1";
export const IN_SCHEMA = "oc-fusion-in/1";
export const OUT_SCHEMA = "oc-fusion/1";
export const SYSTEM_IDS = ["scribe", "soniox", "ours"] as const;
export const ARMS = ["W", "rules", "policy"] as const;

export type Arm = (typeof ARMS)[number];

export class InputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InputError";
    }
}

export class LlmNotSupportedError extends Error {
    constructor() {
        super("the LLM chooser is not implemented in the TypeScript engine; "
            + "route this request to the Python engine");
        this.name = "LlmNotSupportedError";
    }
}

interface InputWord {
    raw: string;
    start?: number;
    end?: number;
    conf?: number | null;
}

interface InputSystem {
    id: string;
    params_sha?: string;
    words: InputWord[];
}

interface ValidatedConfig {
    arm: Arm;
    guard: boolean;
    llm: Record<string, unknown> | null;
    chunking: ChunkConfig;
    audio_sha256: unknown;
    systems: InputSystem[];
}

/** Python renders a list of strings with single quotes and ", " between them. */
function pyList(xs: readonly string[]): string {
    return "[" + xs.map((x) => `'${x}'`).join(", ") + "]";
}

/** Python renders a string with single quotes in these messages; so does this. */
function pyRepr(v: unknown): string {
    if (typeof v === "string") return `'${v.replace(/'/g, "\\'")}'`;
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    return String(v);
}

function validate(payload: unknown): ValidatedConfig {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new InputError("payload is not an object");
    }
    const p = payload as Record<string, unknown>;
    if (p.schema !== IN_SCHEMA) {
        throw new InputError(`schema must be ${pyRepr(IN_SCHEMA)}, got ${pyRepr(p.schema)}`);
    }
    const systems = p.systems;
    if (!Array.isArray(systems) || systems.length !== 3) {
        throw new InputError("systems must be a list of exactly 3 entries");
    }
    for (let n = 0; n < 3; n++) {
        const want = SYSTEM_IDS[n];
        const s = systems[n];
        if (typeof s !== "object" || s === null || Array.isArray(s)) {
            throw new InputError("each system must be an object");
        }
        const sys = s as Record<string, unknown>;
        if (sys.id !== want) {
            throw new InputError(
                `systems must be ordered ${pyList([...SYSTEM_IDS])}; `
                + `got ${pyRepr(sys.id)} where ${pyRepr(want)} was expected`);
        }
        const words = sys.words;
        if (!Array.isArray(words)) {
            throw new InputError(`systems[${want}].words must be a list`);
        }
        for (const w of words) {
            if (typeof w !== "object" || w === null || Array.isArray(w)
                || typeof (w as Record<string, unknown>).raw !== "string") {
                throw new InputError(`systems[${want}].words[].raw must be a string`);
            }
            const c = (w as Record<string, unknown>).conf;
            if (c !== undefined && c !== null && typeof c !== "number") {
                throw new InputError(`systems[${want}].words[].conf must be a number or null`);
            }
        }
    }

    let cfg = p.config;
    if (cfg === undefined || cfg === null) cfg = {};
    if (typeof cfg !== "object" || Array.isArray(cfg)) {
        throw new InputError("config must be an object");
    }
    const c = cfg as Record<string, unknown>;

    const arm = (c.arm ?? "rules") as Arm;
    if (!ARMS.includes(arm)) {
        throw new InputError(
            `config.arm must be one of ${pyList([...ARMS])}, got ${pyRepr(c.arm)}`);
    }
    const guard = c.guard ?? false;
    if (typeof guard !== "boolean") throw new InputError("config.guard must be a boolean");

    const llm = c.llm;
    if (llm !== undefined && llm !== null
        && (typeof llm !== "object" || Array.isArray(llm))) {
        throw new InputError("config.llm must be an object or null");
    }

    let chunking: ChunkConfig;
    try {
        chunking = chunkConfigFrom(c.chunking as Record<string, unknown> | null | undefined);
    } catch (e) {
        throw new InputError(`config.chunking: ${(e as Error).message}`);
    }

    return {
        arm,
        guard,
        llm: (llm ?? null) as Record<string, unknown> | null,
        chunking,
        audio_sha256: p.audio_sha256 ?? null,
        systems: systems as InputSystem[],
    };
}

const AGREEMENT = new Map<number, number>([[3, 1.0], [2, 0.67]]);

function agreement(col: Column, token: string): number {
    let n = 0;
    for (const e of col) if (e === token) n += 1;
    return AGREEMENT.get(n) ?? 0.33;
}

interface Chunk {
    ranges: ChunkRanges;
    pivot: number;
    cols: Column[];
    colidx: [number | null, number | null, number | null][];
    parts: Island[];
    tail: Triple[];
    colOffset: number;
}

function analyse(tokens: string[][], chunkCfg: ChunkConfig): {
    chunks: Chunk[];
    forced: number;
    seams: number[];
} {
    const { chunks: plan, forced } = planChunks(tokens, chunkCfg);
    const out: Chunk[] = [];
    let colOffset = 0;
    for (const ranges of plan) {
        const sub = [0, 1, 2].map((k) => tokens[k].slice(ranges[k][0], ranges[k][1]));
        if (!sub.some((s) => s.length > 0)) continue;
        const pivot = consensusPivot(sub);
        const cols = align3(sub[0], sub[1], sub[2], bandFor(sub));
        const { islands: parts, tail_tr: tail } = R.windowParts(cols, pivot);
        out.push({ ranges, pivot, cols, colidx: columnIndices(cols), parts, tail, colOffset });
        colOffset += cols.length;
    }
    return { chunks: out, forced, seams: out.slice(1).map((c) => c.colOffset) };
}

/** Python's `max(range(3), key=...)` keeps the first index on a tie. */
function longestSpan(spans: readonly (readonly string[])[]): number {
    let best = 0;
    for (let k = 1; k < 3; k++) {
        const a: [number, number] = [spans[k].length, -k];
        const b: [number, number] = [spans[best].length, -best];
        if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) best = k;
    }
    return best;
}

function islandOutput(isl: Island, arm: Arm, guard: boolean, policy: LoadedPolicy): {
    tr: Triple[];
    stage: string;
    rule: string | null;
    fired: boolean;
    llm: null;
} {
    let tr: Triple[];
    let stage: string;
    let rule: string | null;

    if (arm === "W") {
        tr = isl.vote_tr; stage = "rule"; rule = R.RULE_VOTE;
    } else if (arm === "rules") {
        tr = isl.r12_tr; stage = "rule"; rule = R.RULE_R12;
    } else {
        const p = policy.policy[isl.cat];
        if (p === undefined) {
            tr = isl.vote_tr; stage = "rule"; rule = R.RULE_VOTE;
        } else if (p.mode === "rule") {
            tr = R.RULES[p.rule as string](isl); stage = "rule"; rule = p.rule as string;
        } else {
            // With no chooser, the Python falls back to R1+R2 and records the
            // reason. Reaching here means the caller asked for the LLM arm
            // without an LLM, which `fuse` has already rejected.
            throw new LlmNotSupportedError();
        }
    }

    let fired = false;
    if (guard) {
        // The guard replaces the island text with a whole system's span. It
        // does not change which rule routed the island, so `rule` stands and
        // `guard_fired` is what says the text was overridden.
        const res = R.applyGuardTr(isl, tr);
        tr = res.out;
        fired = res.fired;
    }
    return { tr: [...tr], stage, rule, fired, llm: null };
}

export interface FuseOutput {
    schema: string;
    audio_sha256: unknown;
    config: Record<string, unknown>;
    tokens: Record<string, unknown>[];
    islands: Record<string, unknown>[];
    dropped: Record<string, unknown>[];
    stats: Record<string, unknown>;
}

export function fuse(payload: unknown, policy: LoadedPolicy): FuseOutput {
    const cfg = validate(payload);
    const { arm, guard } = cfg;

    if (arm === "policy" && cfg.llm) throw new LlmNotSupportedError();

    const raws = cfg.systems.map((s) => s.words.map((w) => w.raw));
    const confs = cfg.systems.map((s) => s.words.map((w) => w.conf ?? null));
    const tokenized = raws.map((r) => tokenizeWords(r));
    const tokens = tokenized.map((t) => t.tokens);
    const owner = tokenized.map((t) => t.owner);

    const { chunks, forced, seams } = analyse(tokens, cfg.chunking);

    const wordOf = (ch: Chunk, sysi: number, col: number): {
        widx: number | null; raw: string | null; conf: number | null;
    } => {
        const local = ch.colidx[col][sysi];
        if (local === null) return { widx: null, raw: null, conf: null };
        const gidx = ch.ranges[sysi][0] + local;
        const widx = owner[sysi][gidx];
        return { widx, raw: raws[sysi][widx], conf: confs[sysi][widx] };
    };

    const alternatives = (ch: Chunk, isl: Island) => {
        const out: Record<string, unknown>[] = [];
        for (let k = 0; k < 3; k++) {
            const words: string[] = [];
            const confVals: number[] = [];
            const seen = new Set<number>();
            for (const [, , col] of isl.span_tr[k]) {
                const { widx, raw, conf } = wordOf(ch, k, col);
                if (widx === null || seen.has(widx)) continue;
                seen.add(widx);
                words.push(raw as string);
                if (conf !== null) confVals.push(conf);
            }
            out.push({
                src: SYSTEM_IDS[k],
                text: words.join(" "),
                norm: [...isl.spans[k]],
                conf: confVals.length ? pySum(confVals) / confVals.length : null,
            });
        }
        return out;
    };

    const outTokens: Record<string, unknown>[] = [];
    const outIslands: Record<string, unknown>[] = [];
    const dropped: Record<string, unknown>[] = [];
    const statsCat: Record<string, number> = {};
    const statsStage: Record<string, number> = { agree: 0, rule: 0, llm: 0 };
    let nGuard = 0;
    let islCounter = 0;

    const emit = (
        ch: Chunk, triples: readonly Triple[], stage: string,
        islandId: string | null, alts: Record<string, unknown>[] | null,
    ) => {
        for (const [tok, sysi, col] of triples) {
            const { widx, raw } = wordOf(ch, sysi, col);
            outTokens.push({
                i: outTokens.length,
                text: raw !== null ? raw : tok,
                norm: tok,
                src: SYSTEM_IDS[sysi],
                src_word: widx,
                col: ch.colOffset + col,
                island: islandId,
                stage,
                agreement: agreement(ch.cols[col], tok),
                alternatives: alts,
            });
            statsStage[stage] = (statsStage[stage] ?? 0) + 1;
        }
    };

    for (const ch of chunks) {
        for (const isl of ch.parts) {
            emit(ch, isl.before_tr, "agree", null, null);
            const iid = `isl_${islCounter}`;
            islCounter += 1;
            const { tr, stage, rule, fired } = islandOutput(isl, arm, guard, policy);
            nGuard += fired ? 1 : 0;
            const alts = alternatives(ch, isl);
            emit(ch, tr, stage, iid, alts);

            const srcs = new Set(tr.map(([, s]) => s));
            const chosenSrc = srcs.size === 1
                ? SYSTEM_IDS[srcs.values().next().value as number]
                : null;

            outIslands.push({
                id: iid,
                cols: [ch.colOffset + isl.s, ch.colOffset + isl.e - 1],
                category: isl.cat,
                candidates: {
                    scribe: [...isl.spans[0]],
                    soniox: [...isl.spans[1]],
                    ours: [...isl.spans[2]],
                    vote: [...isl.vote],
                    r12: [...isl.r12],
                },
                stage,
                rule,
                chosen_src: chosenSrc,
                guard_fired: fired,
                llm: null,
            });
            statsCat[isl.cat] = (statsCat[isl.cat] ?? 0) + 1;

            if (!tr.length) {
                const best = longestSpan(isl.spans);
                if (isl.spans[best].length) {
                    dropped.push({
                        island: iid,
                        src: SYSTEM_IDS[best],
                        text: alts[best].text,
                        rule: rule ?? stage,
                    });
                }
            }
        }
        emit(ch, ch.tail, "agree", null, null);
    }

    const chunkOut: Record<string, unknown> = {
        rev: cfg.chunking.rev,
        max_tokens: cfg.chunking.max_tokens,
        anchor_n: cfg.chunking.anchor_n,
        search_radius: cfg.chunking.search_radius,
        min_pause_fallback: cfg.chunking.min_pause_fallback,
        n_chunks: chunks.length,
        forced_cuts: forced,
        seams,
    };

    return {
        schema: OUT_SCHEMA,
        audio_sha256: cfg.audio_sha256,
        config: {
            arm,
            guard,
            policy_sha: POLICY_SHA16,
            // Python reports the envelope hash only when the LLM arm actually
            // ran. That arm is rejected above, so it is always absent here.
            llm_envelope_sha: null,
            code_rev: CODE_REV,
            normalizer_rev: NORMALIZER_REV,
            chunking: chunkOut,
            components: Object.fromEntries(
                [0, 1, 2].map((k) => [SYSTEM_IDS[k], cfg.systems[k].params_sha ?? null]),
            ),
        },
        tokens: outTokens,
        islands: outIslands,
        dropped,
        stats: {
            n_tokens: outTokens.length,
            n_islands: outIslands.length,
            by_category: statsCat,
            by_stage: statsStage,
            guard_fired: nGuard,
        },
    };
}

/** Exported for the differential harness, which needs the column view too. */
export { columnClass };
