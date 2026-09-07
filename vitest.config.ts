import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The route gate replays 391 benchmark windows through a real server and
    // takes minutes. It runs from `npm run test:fusion-route-gate`, never from
    // the default suite, so an ordinary `npm test` stays fast.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.gate.test.ts', 'src/**/*.live.test.ts', 'src/**/*.livereplay.test.ts'],
    environment: 'node',
  },
});
