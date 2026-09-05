import { defineConfig } from 'vitest/config';

/**
 * The benchmark-shaped integration gate. One file, one worker, no parallelism:
 * it boots a server, spawns a Python child per window, and its whole point is
 * that the numbers come out identical to the offline run.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.gate.test.ts'],
    environment: 'node',
    testTimeout: 45 * 60_000,
    hookTimeout: 10 * 60_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
