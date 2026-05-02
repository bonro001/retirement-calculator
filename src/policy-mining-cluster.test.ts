import { describe, expect, it } from 'vitest';
import { clusterSessionMatches, type ClusterSessionListing } from './policy-mining-cluster';

function session(opts: {
  baselineFingerprint: string;
  engineVersion: string;
}): ClusterSessionListing {
  return {
    sessionId: 's-test',
    manifest: {
      sessionId: 's-test',
      startedAtIso: new Date().toISOString(),
      trialCount: 2000,
      legacyTargetTodayDollars: 1_000_000,
      totalPolicies: 1,
      startedBy: 'test',
      config: {
        baselineFingerprint: opts.baselineFingerprint,
        engineVersion: opts.engineVersion,
        axes: {
          annualSpendTodayDollars: [100_000],
          primarySocialSecurityClaimAge: [70],
          spouseSocialSecurityClaimAge: [67],
          rothConversionAnnualCeiling: [0],
        },
        assumptions: { simulationRuns: 2000 } as never,
        evaluatedByNodeId: 'test',
        legacyTargetTodayDollars: 1_000_000,
        feasibilityThreshold: 0.85,
      },
    },
    summary: null,
    evaluationCount: 0,
    lastActivityMs: Date.now(),
  };
}

describe('clusterSessionMatches', () => {
  it('requires both baseline fingerprint and engine version to match', () => {
    const row = session({ baselineFingerprint: 'fp-current', engineVersion: 'engine-current' });
    expect(clusterSessionMatches(row, 'fp-current', 'engine-current')).toBe(true);
    expect(clusterSessionMatches(row, 'fp-current', 'engine-old')).toBe(false);
    expect(clusterSessionMatches(row, 'fp-old', 'engine-current')).toBe(false);
  });

  it('rejects missing current identity inputs', () => {
    const row = session({ baselineFingerprint: 'fp-current', engineVersion: 'engine-current' });
    expect(clusterSessionMatches(row, null, 'engine-current')).toBe(false);
    expect(clusterSessionMatches(row, 'fp-current', null)).toBe(false);
  });
});
