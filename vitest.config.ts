import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // `.tmp-*.test.ts` files are utility scripts that happen to use vitest
    // infrastructure (e.g., for writing export snapshots to disk). Exclude
    // from the default run; invoke them explicitly when needed.
    exclude: ['**/node_modules/**', 'src/.tmp-*.test.ts'],
    // Keep test execution deterministic. Long Monte Carlo tiers are batched in
    // scripts/run-model-tests.mjs so a single worker task stays under Vitest's
    // RPC heartbeat window.
    maxWorkers: 1,
    pool: 'forks',
  },
});
