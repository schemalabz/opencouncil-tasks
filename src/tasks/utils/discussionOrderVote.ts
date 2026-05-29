import type { AgendaItemRef } from './decisionPdfExtraction.js';

interface VoteBreakdown {
    order: AgendaItemRef[];
    count: number;
}

export interface DiscussionOrderVoteResult {
    selected: AgendaItemRef[] | null;
    breakdown: VoteBreakdown[];
    nullCount: number;
    totalPdfs: number;
}

function serializeRef(r: AgendaItemRef): string {
    return `${r.agendaItemIndex}:${r.nonAgendaReason ?? ''}`;
}

function serializeOrder(order: AgendaItemRef[]): string {
    return JSON.stringify(order.map(serializeRef));
}

/**
 * Check if order A is a prefix of order B (every element of A matches
 * the corresponding element at the start of B).
 */
function isPrefix(shorter: AgendaItemRef[], longer: AgendaItemRef[]): boolean {
    if (shorter.length > longer.length) return false;
    for (let i = 0; i < shorter.length; i++) {
        if (serializeRef(shorter[i]) !== serializeRef(longer[i])) return false;
    }
    return true;
}

export function selectDiscussionOrder(
    orders: (AgendaItemRef[] | null)[],
): DiscussionOrderVoteResult {
    const totalPdfs = orders.length;
    const nullCount = orders.filter(o => o === null).length;
    const nonNull = orders.filter((o): o is AgendaItemRef[] => o !== null);

    if (nonNull.length === 0) {
        return { selected: null, breakdown: [], nullCount, totalPdfs };
    }

    // Group exact matches first
    const exactGroups = new Map<string, { order: AgendaItemRef[]; count: number }>();
    for (const order of nonNull) {
        const key = serializeOrder(order);
        const existing = exactGroups.get(key);
        if (existing) {
            existing.count++;
        } else {
            exactGroups.set(key, { order, count: 1 });
        }
    }

    // Merge prefix-compatible groups: if order A is a prefix of order B
    // (or vice versa), they agree on the reordering — count them together
    // and keep the longest version.
    const exactList = [...exactGroups.values()].sort((a, b) => b.order.length - a.order.length);
    const merged: Array<{ order: AgendaItemRef[]; count: number }> = [];

    for (const group of exactList) {
        let foundMerge = false;
        for (const existing of merged) {
            // Check if one is a prefix of the other
            if (isPrefix(group.order, existing.order) || isPrefix(existing.order, group.order)) {
                existing.count += group.count;
                // Keep the longer order
                if (group.order.length > existing.order.length) {
                    existing.order = group.order;
                }
                foundMerge = true;
                break;
            }
        }
        if (!foundMerge) {
            merged.push({ order: group.order, count: group.count });
        }
    }

    const breakdown = merged.sort((a, b) => b.count - a.count);
    const best = breakdown[0];
    // Majority = >50% of ALL PDFs (including nulls).
    // Null = "no reorder detected" = vote for natural order.
    // This prevents a few hallucinations from overriding when most PDFs see natural order.
    const selected = best.count > totalPdfs / 2 ? best.order : null;

    return { selected, breakdown, nullCount, totalPdfs };
}
