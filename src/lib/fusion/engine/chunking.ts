/**
 * Text-level chunking, ported from `fusion/chunking.py`, so `align3` never sees
 * more than `maxTokens` per system.
 *
 * The aligner is cubic in time and memory over the three token counts, and a
 * 20-minute segment is several thousand tokens per system. This cuts the three
 * streams where all three agree on the local text, so each chunk fuses
 * independently and the results concatenate.
 *
 * Frozen as `chunk/1`, deterministic: no timing, no randomness.
 *
 *  1. If all three remaining streams fit, emit one final chunk.
 *  2. Otherwise aim at `maxTokens * 0.8` into the scribe stream and look for an
 *     anchor within `searchRadius`: an n-gram occurring exactly once inside
 *     each stream's neighbourhood, at a consistent relative offset.
 *  3. Cut all three immediately before the anchor, which stays with the chunk
 *     that follows. A unique unanimous n-gram is already the alignment there.
 *  4. No anchor means a forced cut at the proportional position, counted rather
 *     than hidden, because a forced cut can split an island.
 *  5. Candidates are tried nearest to the target first, lower index on a tie.
 *
 * One thing JavaScript will not do on its own: Python's `round()` is
 * round-half-to-even, so `round(2.5)` is 2 while `Math.round(2.5)` is 3. That
 * function decides where a cut lands in the other two streams, so the halves
 * are rounded Python's way below.
 */

export const CHUNK_REV = "chunk/1";

/** Fraction of maxTokens aimed at, leaving the anchor search room to move. */
export const CUT_FRACTION = 0.8;

/** How far two streams' relative offsets may differ and still be one moment. */
export const TEMPORAL_TOLERANCE = 0.5;

export interface ChunkConfig {
    rev: string;
    max_tokens: number;
    anchor_n: number;
    search_radius: number;
    min_pause_fallback: number | null;
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
    rev: CHUNK_REV,
    max_tokens: 800,
    anchor_n: 3,
    search_radius: 200,
    min_pause_fallback: null,
};

const KNOWN = new Set(["max_tokens", "anchor_n", "search_radius", "min_pause_fallback"]);
const DROPPED = ["rev", "n_chunks", "forced_cuts", "seams"];

export function chunkConfigFrom(d: Record<string, unknown> | null | undefined): ChunkConfig {
    const given: Record<string, unknown> = { ...(d ?? {}) };
    for (const k of DROPPED) delete given[k];
    const unknown = Object.keys(given).filter((k) => !KNOWN.has(k)).sort();
    if (unknown.length) {
        throw new Error(`unknown chunking keys: [${unknown.map((u) => `'${u}'`).join(", ")}]`);
    }
    const cfg: ChunkConfig = { ...DEFAULT_CHUNK_CONFIG, ...(given as Partial<ChunkConfig>) };
    if (cfg.max_tokens < 1) throw new Error("chunking.max_tokens must be >= 1");
    if (cfg.anchor_n < 1) throw new Error("chunking.anchor_n must be >= 1");
    if (cfg.search_radius < 0) throw new Error("chunking.search_radius must be >= 0");
    return cfg;
}

/** Python's `round`: halves go to the even neighbour, not upwards. */
export function pyRound(x: number): number {
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
}

/** Half-open `[start, end)` clamped into `[lo, hi)`. */
function neighbourhood(lo: number, hi: number, centre: number, radius: number): [number, number] {
    return [Math.max(lo, centre - radius), Math.min(hi, centre + radius + 1)];
}

/**
 * Start positions of `gram` fully inside `[lo, hi)`. Stops at two, because the
 * only question asked is whether the count is exactly one.
 */
function occurrences(
    stream: readonly string[],
    gram: readonly string[],
    lo: number,
    hi: number,
): number[] {
    const n = gram.length;
    const hits: number[] = [];
    for (let p = lo; p <= hi - n; p++) {
        let same = true;
        for (let q = 0; q < n; q++) {
            if (stream[p + q] !== gram[q]) { same = false; break; }
        }
        if (same) {
            hits.push(p);
            if (hits.length > 1) break;
        }
    }
    return hits;
}

/** Where a cut at `scribeCut` in the scribe stream lands in stream k. */
function proportional(
    offsets: readonly number[],
    ends: readonly number[],
    k: number,
    scribeCut: number,
): number {
    const o0 = offsets[0];
    const e0 = ends[0];
    const ok = offsets[k];
    const ek = ends[k];
    const span0 = e0 - o0;
    if (span0 <= 0) return ok;
    const frac = (scribeCut - o0) / span0;
    return ok + Math.trunc(pyRound(frac * (ek - ok)));
}

function findAnchor(
    streams: readonly (readonly string[])[],
    offsets: readonly number[],
    ends: readonly number[],
    cfg: ChunkConfig,
): number[] | null {
    const n = cfg.anchor_n;
    const o0 = offsets[0];
    const e0 = ends[0];
    if (e0 - o0 <= n) return null;

    let target = o0 + Math.max(1, Math.trunc(CUT_FRACTION * cfg.max_tokens));
    target = Math.min(Math.max(target, o0 + 1), e0 - n);

    const nb: [number, number][] = [[0, 0], [0, 0], [0, 0]];
    nb[0] = neighbourhood(o0, e0, target, cfg.search_radius);
    for (const k of [1, 2]) {
        const centre = proportional(offsets, ends, k, target);
        nb[k] = neighbourhood(offsets[k], ends[k], centre, cfg.search_radius);
    }

    const [lo0, hi0] = nb[0];
    const candidates: number[] = [];
    for (let p = lo0; p < Math.max(lo0, hi0 - n + 1); p++) candidates.push(p);
    candidates.sort((a, b) => {
        const da = Math.abs(a - target);
        const db = Math.abs(b - target);
        return da !== db ? da - db : a - b;
    });

    for (const p of candidates) {
        const gram = streams[0].slice(p, p + n);
        if (gram.length < n) continue;

        const hits: number[] = [];
        let ok = true;
        for (let k = 0; k < 3; k++) {
            const h = occurrences(streams[k], gram, nb[k][0], nb[k][1]);
            if (h.length !== 1) { ok = false; break; }
            hits.push(h[0]);
        }
        if (!ok) continue;

        const rel: number[] = [];
        for (let k = 0; k < 3; k++) {
            const [lo, hi] = nb[k];
            const width = Math.max(1, (hi - n) - lo);
            rel.push((hits[k] - lo) / width);
        }
        if (Math.max(...rel) - Math.min(...rel) > TEMPORAL_TOLERANCE) continue;

        // A cut must advance every stream, leave work behind, and hand the
        // aligner no more than maxTokens from ANY stream: the ops table is
        // cubic, so one oversized stream is the whole failure, and capping
        // scribe's side alone would still blow up on a verbose system.
        let bad = false;
        for (let k = 0; k < 3; k++) {
            if (hits[k] <= offsets[k] || hits[k] >= ends[k]
                || hits[k] - offsets[k] > cfg.max_tokens) { bad = true; break; }
        }
        if (bad) continue;
        return hits;
    }
    return null;
}

function forced(
    offsets: readonly number[],
    ends: readonly number[],
    cfg: ChunkConfig,
): number[] {
    const o0 = offsets[0];
    const e0 = ends[0];
    const cut0 = e0 - o0 > 1
        ? Math.min(Math.max(o0 + Math.max(1, Math.trunc(CUT_FRACTION * cfg.max_tokens)), o0 + 1), e0 - 1)
        : e0;
    const cuts = [cut0];
    for (const k of [1, 2]) {
        let c = e0 - o0 > 0 ? proportional(offsets, ends, k, cut0) : offsets[k];
        c = Math.min(Math.max(c, offsets[k]), ends[k]);
        cuts.push(c);
    }
    // A proportional cut follows scribe's fraction of its own remaining span,
    // so a stream several times longer than scribe's can be handed a span far
    // past maxTokens: the cubic blow-up this module exists to prevent.
    for (let k = 0; k < 3; k++) cuts[k] = Math.min(cuts[k], offsets[k] + cfg.max_tokens);

    if (cuts.every((c, k) => c <= offsets[k])) {
        for (let k = 0; k < 3; k++) {
            if (ends[k] > offsets[k]) {
                cuts[k] = Math.min(ends[k], offsets[k] + Math.max(1, cfg.max_tokens));
            }
        }
    }
    return cuts;
}

export type ChunkRanges = [number, number][];

/** Index ranges covering each stream exactly once, plus the forced-cut count. */
export function planChunks(
    streams: readonly (readonly string[])[],
    cfg: ChunkConfig,
): { chunks: ChunkRanges[]; forced: number } {
    const ends = streams.map((s) => s.length);
    let offsets = [0, 0, 0];
    const chunks: ChunkRanges[] = [];
    let forcedCuts = 0;
    let guard = 0;

    for (;;) {
        guard += 1;
        if (guard > 10000) throw new Error("chunking failed to terminate");

        const remaining = [0, 1, 2].map((k) => ends[k] - offsets[k]);
        if (Math.max(...remaining) <= cfg.max_tokens) {
            chunks.push([0, 1, 2].map((k) => [offsets[k], ends[k]] as [number, number]));
            return { chunks, forced: forcedCuts };
        }

        let cuts = findAnchor(streams, offsets, ends, cfg);
        if (cuts === null) {
            cuts = forced(offsets, ends, cfg);
            forcedCuts += 1;
        }
        chunks.push([0, 1, 2].map((k) => [offsets[k], cuts![k]] as [number, number]));
        if (cuts.every((c, k) => c <= offsets[k])) throw new Error("chunking made no progress");
        offsets = [...cuts];
    }
}
