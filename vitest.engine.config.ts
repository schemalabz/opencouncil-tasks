import { defineConfig } from 'vitest/config';

/**
 * The engine equivalence suite. Every test here compares the TypeScript engine
 * against output frozen from `fusion/*.py` over the real 391-window corpus, so
 * it needs the fixture bundle, runs for minutes, and blocks the event loop
 * while it does. Threads report that as an RPC timeout and fail the run, which
 * is why this borrows the gate lane's single forked worker.
 *
 *   npm run test:fusion-engine
 *
 * Regenerate the expected side with `python3 tests/fusion/oracle_dump.py`,
 * `msa_vectors.py` and `normalize_vectors.py`. Without the bundle these skip.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.differential.test.ts'],
    environment: 'node',
    testTimeout: 30 * 60_000,
    hookTimeout: 10 * 60_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
