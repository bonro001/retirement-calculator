import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Keep test execution deterministic and avoid worker RPC heartbeat timeouts
    // during long Monte Carlo suites.
    maxWorkers: 1,
  },
});
