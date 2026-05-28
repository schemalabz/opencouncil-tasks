/**
 * Majority vote for initial roll call across multiple PDFs.
 *
 * All PDFs from the same meeting should have the same initial attendance
 * preamble, but extraction errors or PDFs from a different session can
 * produce outliers. This selects the roll call reported by the majority.
 */

interface RollCallEntry {
    presentMembers: string[];
    absentMembers: string[];
    mayorPresent: { present: boolean; rawText: string } | null;
}

interface RollCallGroup {
    entry: RollCallEntry;
    count: number;
}

export interface RollCallVoteResult {
    /** The winning roll call, or null if no data or no majority */
    selected: RollCallEntry | null;
    breakdown: RollCallGroup[];
    /** Number of PDFs with no roll call data */
    emptyCount: number;
    totalPdfs: number;
}

/**
 * Serialize a roll call to a comparable key.
 * Normalizes by sorting names (extraction order can vary) and
 * comparing the set of names + mayor status.
 */
function serializeRollCall(entry: RollCallEntry): string {
    const present = [...entry.presentMembers].sort().join('|');
    const absent = [...entry.absentMembers].sort().join('|');
    const mayor = entry.mayorPresent?.present ?? 'unknown';
    return `P:${present};;A:${absent};;M:${mayor}`;
}

export function selectRollCall(
    extractions: Array<{
        presentMembers: string[] | null;
        absentMembers: string[] | null;
        mayorPresent: { present: boolean; rawText: string } | null;
    }>,
): RollCallVoteResult {
    const totalPdfs = extractions.length;

    // Filter to PDFs that have roll call data
    const withRoll = extractions.filter(
        e => (e.presentMembers?.length ?? 0) > 0 || (e.absentMembers?.length ?? 0) > 0
    );
    const emptyCount = totalPdfs - withRoll.length;

    if (withRoll.length === 0) {
        return { selected: null, breakdown: [], emptyCount, totalPdfs };
    }

    // Group by serialized content
    const groups = new Map<string, RollCallGroup>();
    for (const e of withRoll) {
        const entry: RollCallEntry = {
            presentMembers: e.presentMembers || [],
            absentMembers: e.absentMembers || [],
            mayorPresent: e.mayorPresent,
        };
        const key = serializeRollCall(entry);
        const existing = groups.get(key);
        if (existing) {
            existing.count++;
        } else {
            groups.set(key, { entry, count: 1 });
        }
    }

    const breakdown = [...groups.values()].sort((a, b) => b.count - a.count);
    const best = breakdown[0];

    // Majority = >50% of PDFs with roll call data
    const selected = best.count > withRoll.length / 2 ? best.entry : null;

    return { selected, breakdown, emptyCount, totalPdfs };
}
