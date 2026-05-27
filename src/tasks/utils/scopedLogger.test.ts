import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScopedLogger } from './scopedLogger.js';

describe('createScopedLogger', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('prefixes all log lines with the task scope', () => {
        const log = createScopedLogger('pollDecisions:zografou/dec22_2025');
        log('Fetched 47 decisions');
        expect(consoleSpy).toHaveBeenCalledWith(
            '[pollDecisions:zografou/dec22_2025] Fetched 47 decisions'
        );
    });

    it('handles multiple arguments', () => {
        const log = createScopedLogger('pollDecisions:zografou/dec22_2025');
        log('Matches:', 5, 'unmatched:', 2);
        expect(consoleSpy).toHaveBeenCalledWith(
            '[pollDecisions:zografou/dec22_2025] Matches:', 5, 'unmatched:', 2
        );
    });

    it('extracts scope from callback URL', () => {
        const log = createScopedLogger.fromCallbackUrl(
            'https://opencouncil.gr/api/cities/zografou/meetings/dec22_2025/taskStatuses/abc123'
        );
        log('test');
        expect(consoleSpy).toHaveBeenCalledWith(
            '[pollDecisions:zografou/dec22_2025] test'
        );
    });

    it('falls back to generic prefix for unparseable URLs', () => {
        const log = createScopedLogger.fromCallbackUrl('http://localhost/unknown');
        log('test');
        expect(consoleSpy).toHaveBeenCalledWith(
            '[pollDecisions:unknown] test'
        );
    });
});
