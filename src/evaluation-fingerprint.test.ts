import { describe, expect, it } from 'vitest';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';

const baseInput = {
  data: {
    household: { state: 'TX' },
    accounts: { cash: { balance: 50_000 } },
  },
  assumptions: {
    simulationRuns: 5_000,
    simulationSeed: 20260416,
  },
  selectedStressors: ['market_down', 'layoff'],
  selectedResponses: ['cut_spending'],
};

describe('buildEvaluationFingerprint', () => {
  it('returns a compact deterministic digest instead of embedding full plan JSON', () => {
    const fp = buildEvaluationFingerprint(baseInput as never);

    expect(fp).toBe(
      buildEvaluationFingerprint({
        ...baseInput,
        selectedStressors: [...baseInput.selectedStressors].reverse(),
      } as never),
    );
    expect(fp).toMatch(/^eval-[0-9a-f]{16}::layoff,market_down\|cut_spending\|$/);
    expect(fp.length).toBeLessThan(80);
    expect(fp).not.toContain('"household"');
  });

  it('changes when the modeled data or assumptions change', () => {
    const fp = buildEvaluationFingerprint(baseInput as never);
    const changedData = buildEvaluationFingerprint({
      ...baseInput,
      data: {
        ...baseInput.data,
        accounts: { cash: { balance: 60_000 } },
      },
    } as never);
    const changedAssumptions = buildEvaluationFingerprint({
      ...baseInput,
      assumptions: {
        ...baseInput.assumptions,
        simulationSeed: 123,
      },
    } as never);

    expect(changedData).not.toBe(fp);
    expect(changedAssumptions).not.toBe(fp);
  });
});
