import { describe, expect, it } from 'vitest';
import { formatUsage } from './show.js';

describe('formatUsage', () => {
    it('renders every counter observeGeneration records, and only when present', () => {
        // Keys mirror the usageDetails written by observeGeneration; a counter
        // that reaches Langfuse but is skipped here is invisible from the CLI.
        expect(formatUsage({ input: 1200, output: 80, web_search_requests: 3, web_fetch_requests: 1, thinking_tokens: 400 }))
            .toBe('1,200 in, 80 out, 3 searches, 1 fetches, 400 thinking');
        expect(formatUsage({ input: 1200, output: 80 })).toBe('1,200 in, 80 out');
    });
});
