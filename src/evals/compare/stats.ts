export function mean(xs: number[]): number {
    if (xs.length === 0) return NaN;
    let s = 0;
    for (const x of xs) s += x;
    return s / xs.length;
}

/** 1 if more than half are 1, 0 if fewer than half, 0.5 on a tie. */
export function majority(xs: number[]): number {
    const twice = 2 * xs.reduce((s, x) => s + x, 0);
    return twice > xs.length ? 1 : twice < xs.length ? 0 : 0.5;
}

/** Two-sided exact McNemar: binomial(b + c, 1/2) tail on the smaller discordant count. */
export function exactMcNemarP(b: number, c: number): number {
    const n = b + c;
    if (n === 0) return 1;
    const k = Math.min(b, c);
    // Log space: 0.5^n underflows past n ≈ 1074.
    let logPmf = -n * Math.LN2;
    let tail = 0;
    for (let i = 0; i <= k; i++) {
        tail += Math.exp(logPmf);
        logPmf += Math.log((n - i) / (i + 1));
    }
    return Math.min(1, 2 * tail);
}

/** Holm–Bonferroni adjusted p-values, in the input order. */
export function holm(pValues: number[]): number[] {
    const m = pValues.length;
    const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
    const adjusted = new Array<number>(m);
    let running = 0;
    order.forEach(({ p, i }, rank) => {
        running = Math.max(running, Math.min(1, (m - rank) * p));
        adjusted[i] = running;
    });
    return adjusted;
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * 95% percentile CI of the mean per-case diff, resampling whole clusters with replacement.
 * Cases in one cluster (a body, a meeting) share failure causes, so resampling them as a unit
 * keeps "8 regressions in one body" from looking like 8 independent ones.
 */
export function clusterBootstrapCI(
    diffsByCluster: Map<string, number[]>,
    opts: { iters?: number; seed?: number } = {},
): [number, number] {
    const iters = opts.iters ?? 4000;
    const clusters = [...diffsByCluster.values()]
        .filter(ds => ds.length > 0)
        .map(ds => ({ sum: ds.reduce((s, d) => s + d, 0), n: ds.length }));
    if (clusters.length === 0) return [NaN, NaN];
    const rand = mulberry32(opts.seed ?? 1);
    const means = new Array<number>(iters);
    for (let it = 0; it < iters; it++) {
        let sum = 0;
        let n = 0;
        for (let j = 0; j < clusters.length; j++) {
            const c = clusters[Math.floor(rand() * clusters.length)];
            sum += c.sum;
            n += c.n;
        }
        means[it] = sum / n;
    }
    means.sort((x, y) => x - y);
    return [means[Math.floor(0.025 * iters)], means[Math.min(iters - 1, Math.floor(0.975 * iters))]];
}
