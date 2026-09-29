/**
 * Pick `wanted` items spread evenly across `found`, rather than the first
 * `wanted` of them.
 *
 * The spread is across what the caller collected, not across whatever it was
 * collected from: a document search capped at a ceiling, or the segments of one
 * meeting that changed between two runs.
 */
export function thinToSample<T>(found: T[], wanted: number): T[] {
    if (wanted <= 0) return [];
    if (found.length <= wanted) return found;
    const step = (found.length - 1) / (wanted - 1 || 1);
    // `!== undefined`, not `filter(Boolean)`: the guard is for a stride that ran
    // past the end, and a falsy element is a legitimate pick.
    return Array.from({ length: wanted }, (_, i) => found[Math.round(i * step)]).filter((d): d is T => d !== undefined);
}
