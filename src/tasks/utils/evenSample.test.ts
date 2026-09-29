import { describe, it, expect } from 'vitest';
import { thinToSample } from './evenSample.js';

describe('thinToSample', () => {
    const found = Array.from({ length: 10 }, (_, i) => i);

    it('takes the ends and a fixed stride between them', () => {
        expect(thinToSample(found, 3)).toEqual([0, 5, 9]);
    });

    it('returns everything when fewer were found than wanted', () => {
        expect(thinToSample([1, 2], 5)).toEqual([1, 2]);
    });

    it('returns everything when exactly as many were found as wanted', () => {
        expect(thinToSample(found, 10)).toEqual(found);
    });

    it('takes the oldest end when only one is wanted', () => {
        // `wanted - 1 || 1` guards the division; without it the stride is Infinity.
        expect(thinToSample(found, 1)).toEqual([0]);
    });

    it('takes nothing when nothing is wanted', () => {
        expect(thinToSample(found, 0)).toEqual([]);
    });
});
