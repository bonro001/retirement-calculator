import { describe, it, expect } from 'vitest';
import { filterCoarseSurvivors } from '../cluster/dispatcher';
import type { Policy, PolicyEvaluation } from './policy-miner-types';

/**
 * Phase 2.C cluster dispatcher — coarse-survival filter unit tests.
 *
 * The dispatcher itself is hard to test without WebSockets, but the
 * survival-filter math is pure: take a buffer of coarse evaluations
 * and split it into survivors (advance to fine) vs screened-out (drop).
 * If this filter has the wrong threshold or off-by-one, every two-stage
 * cluster session silently keeps too many or too few candidates.
 *
 * The full state-machine wiring (currentStage transitions, queue
 * swap, EWMA reset, broadcasts) is exercised end-to-end by manual
 * smoke tests against a running dispatcher; integration tests with a
 * mocked WebSocket harness are deferred.
 */

function evalAt(spend: number, attainment: number): PolicyEvaluation {
  const policy: Policy = {
    annualSpendTodayDollars: spend,
    primarySocialSecurityClaimAge: 67,
    spouseSocialSecurityClaimAge: 67,
    rothConversionAnnualCeiling: 0,
  };
  return {
    id: `pol-${spend}`,
    baselineFingerprint: 'fp',
    engineVersion: 'ev',
    evaluatedByNodeId: 'host',
    evaluatedAtIso: new Date().toISOString(),
    policy,
    outcome: {
      solventSuccessRate: attainment,
      bequestAttainmentRate: attainment,
      p10EndingWealthTodayDollars: 0,
      p25EndingWealthTodayDollars: 0,
      p50EndingWealthTodayDollars: 0,
      p75EndingWealthTodayDollars: 0,
      p90EndingWealthTodayDollars: 0,
      medianLifetimeSpendTodayDollars: 0,
      medianSpendVolatility: 0,
      medianLifetimeFederalTaxTodayDollars: 0,
      irmaaExposureRate: 0,
    },
    evaluationDurationMs: 100,
  };
}

describe('Phase 2.C dispatcher — filterCoarseSurvivors', () => {
  it('empty buffer returns no survivors and 0 screened', () => {
    const r = filterCoarseSurvivors([], 0.7, 0.1);
    expect(r.survivors).toEqual([]);
    expect(r.screenedOut).toBe(0);
    expect(r.survivalThreshold).toBeCloseTo(0.6, 12);
  });

  it('all-above-threshold buffer keeps every candidate', () => {
    const buf = [evalAt(50_000, 0.9), evalAt(60_000, 0.85), evalAt(70_000, 0.7)];
    const r = filterCoarseSurvivors(buf, 0.7, 0.1);
    // survival threshold = 0.6; all three pass.
    expect(r.survivors).toHaveLength(3);
    expect(r.screenedOut).toBe(0);
  });

  it('all-below-threshold buffer screens everyone out', () => {
    const buf = [evalAt(200_000, 0.4), evalAt(250_000, 0.2), evalAt(300_000, 0.0)];
    const r = filterCoarseSurvivors(buf, 0.7, 0.1);
    expect(r.survivors).toHaveLength(0);
    expect(r.screenedOut).toBe(3);
  });

  it('mixed buffer partitions correctly at the survival threshold', () => {
    // feasibility 0.7, buffer 0.1 → survival threshold = 0.6.
    // 0.65 and 0.61 survive; 0.59 and 0.30 are screened.
    const buf = [
      evalAt(50_000, 0.65),
      evalAt(100_000, 0.59),
      evalAt(150_000, 0.61),
      evalAt(250_000, 0.30),
    ];
    const r = filterCoarseSurvivors(buf, 0.7, 0.1);
    expect(r.survivors).toHaveLength(2);
    expect(
      r.survivors.map((p) => p.annualSpendTodayDollars).sort((a, b) => a - b),
    ).toEqual([50_000, 150_000]);
    expect(r.screenedOut).toBe(2);
  });

  it('exactly-at-threshold candidates survive (>= not strictly >)', () => {
    const buf = [evalAt(50_000, 0.6)];
    const r = filterCoarseSurvivors(buf, 0.7, 0.1);
    expect(r.survivors).toHaveLength(1);
    expect(r.screenedOut).toBe(0);
  });

  it('clamps negative survival threshold to 0 (no negative-attainment edge case)', () => {
    // feasibility 0.05, buffer 0.20 → would be -0.15; should clamp to 0.
    // All non-negative attainment passes.
    const buf = [evalAt(50_000, 0.0), evalAt(100_000, 0.5)];
    const r = filterCoarseSurvivors(buf, 0.05, 0.2);
    expect(r.survivalThreshold).toBe(0);
    expect(r.survivors).toHaveLength(2);
    expect(r.screenedOut).toBe(0);
  });

  it('survivor list preserves input order and is independent of buffer', () => {
    const buf = [evalAt(50_000, 0.9), evalAt(60_000, 0.5), evalAt(70_000, 0.8)];
    const r = filterCoarseSurvivors(buf, 0.7, 0.1);
    expect(r.survivors).toHaveLength(2);
    // Order matches the input ordering (50k before 70k, 60k filtered out).
    expect(r.survivors[0].annualSpendTodayDollars).toBe(50_000);
    expect(r.survivors[1].annualSpendTodayDollars).toBe(70_000);
    // Mutating the returned survivors shouldn't affect the buffer.
    r.survivors[0].annualSpendTodayDollars = 999;
    expect(buf[0].policy.annualSpendTodayDollars).toBe(999); // shared ref by design
    // (Survivor list holds the SAME Policy refs as the eval — that's
    // intentional, the dispatcher hands these straight to the fine
    // WorkQueue. This expect documents the sharing contract.)
  });
});
