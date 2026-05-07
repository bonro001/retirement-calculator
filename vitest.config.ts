import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // `.tmp-*.test.ts` files are utility scripts that happen to use vitest
    // infrastructure (e.g., for writing export snapshots to disk). Exclude
    // from the default run; invoke them explicitly when needed.
    exclude: ['**/node_modules/**', 'src/.tmp-*.test.ts'],
    // Keep test execution deterministic and avoid worker RPC heartbeat timeouts
    // during long Monte Carlo suites.
    maxWorkers: 1,
    pool: 'forks',
  },
});
