import { describe, expect, it } from 'vitest';
import { comparePathResults, runEngineCompare } from './engine-compare';
import type { PathResult } from './types';

describe('engine random tape compare', () => {
  it('replays a recorded raw simulation tape without changing outputs', () => {
    const report = runEngineCompare({
      trials: 20,
      mode: 'raw_simulation',
      recordTape: true,
    });

    expect(report.pass).toBe(true);
    expect(report.firstDifference).toBeNull();
    expect(report.recordedTape?.trials).toHaveLength(20);
    expect(report.checkedFields).toBeGreaterThan(0);
  });

  it('replays a recorded planner-enhanced tape without changing outputs', () => {
    const report = runEngineCompare({
      trials: 20,
      mode: 'planner_enhanced',
      recordTape: true,
    });

    expect(report.pass).toBe(true);
    expect(report.firstDifference).toBeNull();
    expect(report.recordedTape?.trials[0]?.marketPath.length).toBeGreaterThan(0);
  });

  it('reports the first divergent field', () => {
    const expected = {
      successRate: 1,
      yearlySeries: [{ year: 2026, medianAssets: 100 }],
    } as unknown as PathResult;
    const actual = {
      successRate: 1,
      yearlySeries: [{ year: 2026, medianAssets: 102 }],
    } as unknown as PathResult;

    const report = comparePathResults(expected, actual, 0);

    expect(report.pass).toBe(false);
    expect(report.firstDifference?.field).toBe('yearlySeries[0].medianAssets');
    expect(report.firstDifference?.delta).toBe(2);
  });
});
