import { describe, it, expect } from 'vitest';
import { selectDiscussionOrder } from './discussionOrderVote.js';
import type { AgendaItemRef } from './decisionPdfExtraction.js';

function ref(index: number, nonAgendaReason: 'outOfAgenda' | null = null): AgendaItemRef {
    return { agendaItemIndex: index, nonAgendaReason };
}

describe('selectDiscussionOrder', () => {
    it('returns null when all PDFs report null', () => {
        const result = selectDiscussionOrder([null, null, null]);
        expect(result.selected).toBeNull();
    });

    it('returns the order when majority of all PDFs agree', () => {
        const order = [ref(1, 'outOfAgenda'), ref(2, 'outOfAgenda'), ref(8)];
        // 3 out of 5 total = 60% → majority
        const result = selectDiscussionOrder([order, order, order, null, [ref(3)]]);
        expect(result.selected).toEqual(order);
    });

    it('returns null when no majority exists', () => {
        const orderA = [ref(1, 'outOfAgenda'), ref(8)];
        const orderB = [ref(3)];
        const orderC = [ref(5), ref(6)];
        const result = selectDiscussionOrder([orderA, orderB, orderC]);
        expect(result.selected).toBeNull();
    });

    it('requires all non-null to agree when only 2 non-null responses', () => {
        const orderA = [ref(1, 'outOfAgenda'), ref(8)];
        const orderB = [ref(3)];
        const result = selectDiscussionOrder([null, orderA, null, orderB, null]);
        expect(result.selected).toBeNull();
    });

    it('rejects when non-null count is less than half of total PDFs', () => {
        // 2 agree out of 5 total = 40% → not majority
        const order = [ref(1, 'outOfAgenda'), ref(8)];
        const result = selectDiscussionOrder([null, order, null, order, null]);
        expect(result.selected).toBeNull();
    });

    it('selects when non-null count exceeds half of total PDFs', () => {
        const order = [ref(1, 'outOfAgenda'), ref(8)];
        // 4 out of 5 total = 80% → majority
        const result = selectDiscussionOrder([order, order, order, null, order]);
        expect(result.selected).toEqual(order);
    });

    it('rejects single hallucination against many nulls (dec22 case)', () => {
        // 1 out of 7 total = 14% → not majority
        const result = selectDiscussionOrder([null, null, null, [ref(3)], null, null, null]);
        expect(result.selected).toBeNull();
    });

    it('groups prefix-compatible orders together (short is prefix of long)', () => {
        const short = [ref(3), ref(4), ref(5), ref(6), ref(7), ref(8), ref(1), ref(2)];
        const long = [ref(3), ref(4), ref(5), ref(6), ref(7), ref(8), ref(1), ref(2), ref(9), ref(10), ref(11)];
        // 10 short + 10 long = tie if exact, but prefix-compatible = 20/20 agree
        const orders = [
            ...Array(10).fill(short),
            ...Array(10).fill(long),
        ] as (AgendaItemRef[] | null)[];
        const result = selectDiscussionOrder(orders);
        // Should select the longest compatible version
        expect(result.selected).toEqual(long);
    });

    it('prefix grouping still requires majority', () => {
        const orderA = [ref(3), ref(4), ref(1), ref(2)];
        const orderB = [ref(5), ref(6), ref(1), ref(2)];
        // Different prefixes — not compatible
        const result = selectDiscussionOrder([orderA, orderA, orderB, orderB]);
        expect(result.selected).toBeNull();
    });

    it('provides vote breakdown in the result', () => {
        const orderA = [ref(1, 'outOfAgenda'), ref(8)];
        const orderB = [ref(3)];
        const result = selectDiscussionOrder([orderA, orderA, orderA, orderB, null]);
        expect(result.breakdown).toEqual([
            { order: orderA, count: 3 },
            { order: orderB, count: 1 },
        ]);
        expect(result.nullCount).toBe(1);
        expect(result.totalPdfs).toBe(5);
    });
});
