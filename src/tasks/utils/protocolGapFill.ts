export interface ProtocolPattern {
    prefix: string;
    suffix: string;
    /** The numbers in the main sequential cluster (sorted). Outliers are excluded. */
    numbers: number[];
    sequential: boolean;
    /** Numbers that were excluded from the main cluster as outliers. */
    outliers: number[];
}

/**
 * Parse a protocol number string into its prefix, numeric part, and suffix.
 * Examples:
 *   "595"         -> { prefix: "", num: 595, suffix: "" }
 *   "595/2025"    -> { prefix: "", num: 595, suffix: "/2025" }
 *   "ΑΔΣ 5/2026" -> { prefix: "ΑΔΣ ", num: 5, suffix: "/2026" }
 */
function parseProtocolNumber(pn: string): { prefix: string; num: number; suffix: string } | null {
    // Match: optional prefix (non-digit chars), then digits, then optional suffix (e.g. /2025)
    const match = pn.match(/^(\D*?)(\d+)(\/.+)?$/);
    if (!match) return null;
    const [, prefixRaw, numStr, suffixRaw] = match;
    return {
        prefix: prefixRaw ?? '',
        num: parseInt(numStr, 10),
        suffix: suffixRaw ?? '',
    };
}

/**
 * Find the largest cluster of numbers where consecutive gaps don't exceed maxGap.
 * Returns the cluster and any outlier numbers not in the cluster.
 */
function findLargestCluster(sorted: number[], maxGap: number = 3): { cluster: number[]; outliers: number[] } {
    if (sorted.length === 0) return { cluster: [], outliers: [] };

    // Build runs of consecutive-ish numbers (gaps within maxGap)
    const runs: number[][] = [[sorted[0]]];
    for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i] - sorted[i - 1] - 1;
        if (gap < maxGap) {
            runs[runs.length - 1].push(sorted[i]);
        } else {
            runs.push([sorted[i]]);
        }
    }

    // Pick the longest run
    let bestRun = runs[0];
    for (const run of runs) {
        if (run.length > bestRun.length) bestRun = run;
    }

    const clusterSet = new Set(bestRun);
    const outliers = sorted.filter(n => !clusterSet.has(n));

    return { cluster: bestRun, outliers };
}

/**
 * Detect the sequential pattern in a set of protocol number strings.
 * Finds the largest sequential cluster, treating distant numbers as outliers.
 * Returns null if fewer than 3 numbers or formats are inconsistent.
 */
export function detectProtocolPattern(protocolNumbers: string[]): ProtocolPattern | null {
    if (protocolNumbers.length < 3) return null;

    const parsed = protocolNumbers.map(parseProtocolNumber);
    if (parsed.some(p => p === null)) return null;

    const valid = parsed as Array<{ prefix: string; num: number; suffix: string }>;

    // Check all have the same prefix and suffix
    const { prefix, suffix } = valid[0];
    if (!valid.every(p => p.prefix === prefix && p.suffix === suffix)) return null;

    const allNumbers = valid.map(p => p.num).sort((a, b) => a - b);

    // Find the largest cluster of sequential numbers
    const { cluster, outliers } = findLargestCluster(allNumbers);

    // Need at least 3 numbers in the cluster to be meaningful
    const sequential = cluster.length >= 3;

    return { prefix, suffix, numbers: cluster, sequential, outliers };
}

/**
 * Find missing numbers in a sorted sequence.
 * Returns empty if any individual gap exceeds maxGapSize.
 */
export function findGaps(numbers: number[], options?: { maxGapSize?: number }): number[] {
    const maxGapSize = options?.maxGapSize ?? 3;
    const sorted = [...numbers].sort((a, b) => a - b);
    const gaps: number[] = [];

    for (let i = 0; i < sorted.length - 1; i++) {
        const gapSize = sorted[i + 1] - sorted[i] - 1;
        if (gapSize >= maxGapSize) return [];
        for (let n = sorted[i] + 1; n < sorted[i + 1]; n++) {
            gaps.push(n);
        }
    }

    return gaps;
}

/**
 * Reconstruct a full protocol number string from a pattern and a gap number.
 */
export function reconstructProtocolNumber(pattern: Pick<ProtocolPattern, 'prefix' | 'suffix'>, gapNumber: number): string {
    return `${pattern.prefix}${gapNumber}${pattern.suffix}`;
}

