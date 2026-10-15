import { describe, expect, it } from 'vitest';
import { lintRegistry } from '../registry/lint.js';
import { loadDetectorCases, loadModes } from '../registry/registry.js';
import { GUARDED_STATUSES } from '../registry/schema.js';
import { runDetectorCases } from './runDetectorCases.js';

// The CI gate for evals/failure-modes. Guarded modes must have passing cases; code
// detectors at any status run too, since they need no API.
const modes = loadModes().filter(m => GUARDED_STATUSES.includes(m.status) || m.detector?.kind === 'code');

describe('failure-mode registry', () => {
    it('lints clean', () => {
        expect(lintRegistry()).toEqual([]);
    });

    // it.each over an empty list makes no tests, so a registry that stopped loading would pass.
    it('loads the guarded and code-detector modes', () => {
        expect(modes.length).toBeGreaterThan(10);
    });

    it.each(modes.map(m => [`${m.id} ${m.slug}`, m] as const))('%s: every detector case holds', async (_, mode) => {
        const cases = loadDetectorCases(mode);
        expect(cases.length).toBeGreaterThan(0);
        const failures = (await runDetectorCases(mode, cases))
            .filter(o => !o.ok)
            .map(o => ({ file: o.case.file?.split('/').pop(), kind: o.case.kind, why: o.why, got: o.got }));
        expect(failures).toEqual([]);
    }, 30_000); // a detector's first run imports the task module it checks
});
