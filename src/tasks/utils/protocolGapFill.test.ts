import { describe, it, expect } from 'vitest';
import {
    detectProtocolPattern,
    findGaps,
    reconstructProtocolNumber,
} from './protocolGapFill.js';

describe('detectProtocolPattern', () => {
    it('detects plain number format', () => {
        const result = detectProtocolPattern(['595', '596', '597', '598']);
        expect(result).not.toBeNull();
        expect(result!.prefix).toBe('');
        expect(result!.suffix).toBe('');
        expect(result!.numbers).toEqual([595, 596, 597, 598]);
        expect(result!.sequential).toBe(true);
        expect(result!.outliers).toEqual([]);
    });

    it('detects N/YYYY format', () => {
        const result = detectProtocolPattern(['595/2025', '596/2025', '597/2025']);
        expect(result).not.toBeNull();
        expect(result!.prefix).toBe('');
        expect(result!.suffix).toBe('/2025');
        expect(result!.numbers).toEqual([595, 596, 597]);
        expect(result!.sequential).toBe(true);
        expect(result!.outliers).toEqual([]);
    });

    it('detects PREFIX N/YYYY format', () => {
        const result = detectProtocolPattern(['ΑΔΣ 5/2026', 'ΑΔΣ 6/2026', 'ΑΔΣ 7/2026']);
        expect(result).not.toBeNull();
        expect(result!.prefix).toBe('ΑΔΣ ');
        expect(result!.suffix).toBe('/2026');
        expect(result!.numbers).toEqual([5, 6, 7]);
        expect(result!.sequential).toBe(true);
        expect(result!.outliers).toEqual([]);
    });

    it('returns non-sequential when all numbers are scattered', () => {
        // 3 numbers, all far apart — no cluster of 3+
        const result = detectProtocolPattern(['10/2025', '50/2025', '200/2025']);
        expect(result).not.toBeNull();
        expect(result!.sequential).toBe(false);
    });

    it('returns null for fewer than 3 numbers', () => {
        expect(detectProtocolPattern(['1/2025', '2/2025'])).toBeNull();
        expect(detectProtocolPattern([])).toBeNull();
    });

    it('returns null for mixed formats', () => {
        expect(detectProtocolPattern(['595/2025', '596', 'ΑΔΣ 597/2025'])).toBeNull();
    });

    it('handles numbers with gaps but still sequential', () => {
        const result = detectProtocolPattern(['10/2025', '11/2025', '13/2025', '14/2025']);
        expect(result).not.toBeNull();
        expect(result!.sequential).toBe(true);
        expect(result!.numbers).toEqual([10, 11, 13, 14]);
        expect(result!.outliers).toEqual([]);
    });

    it('finds main cluster and excludes outliers', () => {
        // Main cluster: 499-535, outliers: 564, 568
        const numbers = [
            '499/2025', '500/2025', '503/2025',
            '506/2025', '507/2025', '508/2025', '509/2025', '510/2025',
            '511/2025', '512/2025', '513/2025', '514/2025', '515/2025',
            '516/2025', '517/2025', '518/2025',
            '521/2025', '523/2025', '524/2025', '525/2025', '526/2025',
            '527/2025', '528/2025', '529/2025', '530/2025', '531/2025',
            '532/2025', '533/2025', '534/2025', '535/2025',
            '564/2025', '568/2025',
        ];
        const result = detectProtocolPattern(numbers);
        expect(result).not.toBeNull();
        expect(result!.sequential).toBe(true);
        expect(result!.outliers).toEqual([564, 568]);
        expect(result!.numbers).not.toContain(564);
        expect(result!.numbers).not.toContain(568);
        expect(result!.numbers).toContain(499);
        expect(result!.numbers).toContain(535);
    });

    it('finds cluster even with a single outlier', () => {
        const result = detectProtocolPattern(['10/2025', '11/2025', '12/2025', '50/2025']);
        expect(result).not.toBeNull();
        expect(result!.sequential).toBe(true);
        expect(result!.numbers).toEqual([10, 11, 12]);
        expect(result!.outliers).toEqual([50]);
    });
});

describe('findGaps', () => {
    it('finds a simple gap', () => {
        expect(findGaps([1, 2, 4, 5])).toEqual([3]);
    });

    it('finds multiple gaps', () => {
        expect(findGaps([1, 3, 5, 7])).toEqual([2, 4, 6]);
    });

    it('returns empty when no gaps', () => {
        expect(findGaps([1, 2, 3, 4])).toEqual([]);
    });

    it('returns empty when a gap exceeds max size', () => {
        // Default maxGapSize is 3; gap of 4 (5 to 10) exceeds it
        expect(findGaps([1, 2, 3, 5, 10])).toEqual([]);
    });

    it('respects custom maxGapSize', () => {
        expect(findGaps([1, 2, 5], { maxGapSize: 2 })).toEqual([]);
        expect(findGaps([1, 2, 5], { maxGapSize: 3 })).toEqual([3, 4]);
    });
});

describe('reconstructProtocolNumber', () => {
    it('rebuilds plain number', () => {
        const pattern = { prefix: '', suffix: '', numbers: [1], sequential: true };
        expect(reconstructProtocolNumber(pattern, 42)).toBe('42');
    });

    it('rebuilds N/YYYY format', () => {
        const pattern = { prefix: '', suffix: '/2025', numbers: [1], sequential: true };
        expect(reconstructProtocolNumber(pattern, 596)).toBe('596/2025');
    });

    it('rebuilds PREFIX N/YYYY format', () => {
        const pattern = { prefix: 'ΑΔΣ ', suffix: '/2026', numbers: [1], sequential: true };
        expect(reconstructProtocolNumber(pattern, 8)).toBe('ΑΔΣ 8/2026');
    });
});
