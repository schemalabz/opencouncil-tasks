import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The live suite calls three paid vendors, so it needs credentials and
    // spends money. It runs from `npm run test:fusion-live` behind
    // FUSION_LIVE=1, never from the default suite.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.live.test.ts'],
    environment: 'node',
  },
});
