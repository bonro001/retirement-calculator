import { describe, it } from 'vitest';
import { runGoldenScenarios } from './src/verification-harness';
import { GOLDEN_SCENARIOS } from './src/verification-scenarios';

describe('print verification', () => {
  it('prints reports', () => {
    const reports = runGoldenScenarios(GOLDEN_SCENARIOS);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(reports, null, 2));
  });
});
