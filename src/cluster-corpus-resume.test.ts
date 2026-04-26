/**
 * Unit tests for the D.5 resume path in `cluster/corpus-writer.ts`.
 *
 * Focus: `findResumableSessions` correctly distinguishes "crashed
 * mid-session" (manifest only) from "cleanly closed" (manifest +
 * summary), and `openSessionForWrite({resume:true})` continues writing
 * to the same JSONL without clobbering existing lines or the original
 * manifest.
 *
 * We work in a per-test temp dir under os.tmpdir so the tests don't
 * touch `cluster/data/sessions/` and don't race when run in parallel.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendEvaluations,
  closeSessionWithStats,
  findResumableSessions,
  openSessionForWrite,
  type SessionManifest,
} from '../cluster/corpus-writer';
import type { PolicyEvaluation, PolicyMiningSessionConfig } from './policy-miner-types';

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'cluster-corpus-test-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function makeConfig(): PolicyMiningSessionConfig {
  return {
    baselineFingerprint: 'baseline-fingerprint-abcdef0123456789',
    engineVersion: 'engine-test-1',
    axes: {
      annualSpendTodayDollars: [60_000, 70_000],
      primarySocialSecurityClaimAge: [67],
      spouseSocialSecurityClaimAge: [null],
      rothConversionAnnualCeiling: [0],
    },
    feasibilityThreshold: 0.7,
    trialCount: 100,
    legacyTargetTodayDollars: 1_000_000,
  };
}

function makeManifest(sessionId: string): SessionManifest {
  return {
    sessionId,
    startedAtIso: new Date().toISOString(),
    config: makeConfig(),
    trialCount: 100,
    legacyTargetTodayDollars: 1_000_000,
    totalPolicies: 2,
    startedBy: 'test-controller',
  };
}

function makeEval(id: string, attainment: number, spend: number): PolicyEvaluation {
  return {
    id,
    policy: {
      annualSpendTodayDollars: spend,
      primarySocialSecurityClaimAge: 67,
      spouseSocialSecurityClaimAge: null,
      rothConversionAnnualCeiling: 0,
    },
    baselineFingerprint: 'baseline-fingerprint-abcdef0123456789',
    engineVersion: 'engine-test-1',
    evaluatedByNodeId: 'test-node',
    evaluatedAtIso: new Date().toISOString(),
    trialCount: 100,
    outcome: {
      bequestAttainmentRate: attainment,
      p50EndingWealthTodayDollars: spend * 5,
      medianLifetimeRealSpendTodayDollars: spend,
      effectiveLifetimeFederalTax: 0,
      spendVolatilityIndex: 0,
      irmaaYearsTriggered: 0,
      yearsBelowComfortFloor: 0,
    },
  };
}

describe('findResumableSessions', () => {
  it('returns nothing when the data dir is empty / missing', () => {
    expect(findResumableSessions(rootDir)).toEqual([]);
  });

  it('skips cleanly-closed sessions (those with summary.json)', () => {
    const manifest = makeManifest('s-clean');
    openSessionForWrite(manifest, rootDir);
    appendEvaluations('s-clean', [makeEval('pol_aaa', 0.9, 60_000)]);
    closeSessionWithStats('s-clean', 'completed', manifest.startedAtIso, {
      totalPolicies: 2,
      evaluatedCount: 1,
      feasibleCount: 1,
    });
    expect(findResumableSessions(rootDir)).toHaveLength(0);
  });

  it('returns crashed sessions (manifest but no summary) with evaluation seed data', () => {
    const manifest = makeManifest('s-crashed');
    openSessionForWrite(manifest, rootDir);
    appendEvaluations('s-crashed', [
      makeEval('pol_111', 0.8, 60_000),
      makeEval('pol_222', 0.9, 70_000),
    ]);
    // Don't close — simulates a crash before summary.json is written.

    const found = findResumableSessions(rootDir);
    expect(found).toHaveLength(1);
    expect(found[0].manifest.sessionId).toBe('s-crashed');
    expect(found[0].evaluationCount).toBe(2);
    expect(found[0].evaluatedIds).toEqual(new Set(['pol_111', 'pol_222']));
    // bestSoFar picks the higher-spend feasible candidate.
    expect(found[0].bestSoFar?.id).toBe('pol_222');
  });

  it('tolerates a partial trailing line from a mid-write crash', () => {
    const manifest = makeManifest('s-partial');
    openSessionForWrite(manifest, rootDir);
    appendEvaluations('s-partial', [makeEval('pol_complete', 0.9, 70_000)]);
    // Simulate a partial write — append half a JSON object with no
    // newline. corpus-writer flushes after each batch, so this happens
    // only if the OS dies between writev and the next batch arriving.
    const path = join(rootDir, 'sessions', 's-partial', 'evaluations.jsonl');
    const before = readFileSync(path, 'utf-8');
    writeFileSync(path, before + '{"id":"pol_truncated","poli');

    const found = findResumableSessions(rootDir);
    expect(found).toHaveLength(1);
    // Only the well-formed line counts.
    expect(found[0].evaluationCount).toBe(1);
    expect(found[0].evaluatedIds).toEqual(new Set(['pol_complete']));
  });

  it('skips dirs with malformed manifest.json rather than throwing', () => {
    const sessionDir = join(rootDir, 'sessions', 's-broken');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'manifest.json'), '{ not-json');
    // Not throwing is the contract.
    expect(() => findResumableSessions(rootDir)).not.toThrow();
    expect(findResumableSessions(rootDir)).toHaveLength(0);
  });
});

describe('openSessionForWrite resume mode', () => {
  it('preserves the existing manifest and continues appending', () => {
    const manifest = makeManifest('s-keep');
    openSessionForWrite(manifest, rootDir);
    appendEvaluations('s-keep', [makeEval('pol_first', 0.8, 60_000)]);
    // Crash: simulate the dispatcher dying without close. We need to
    // drop the in-memory entry too so the resume path can re-open the
    // same session id.
    closeSessionWithStats('s-keep', 'cancelled', manifest.startedAtIso, {
      totalPolicies: 2,
      evaluatedCount: 1,
      feasibleCount: 1,
    });
    // Delete the summary so findResumableSessions sees this as crashed.
    rmSync(join(rootDir, 'sessions', 's-keep', 'summary.json'));

    // Mutate the manifest object the resume call would supply — to
    // prove the on-disk manifest is NOT clobbered. This mimics the
    // dispatcher recreating the manifest from runtime config; it
    // should defer to whatever's already on disk.
    const newManifest: SessionManifest = {
      ...manifest,
      startedBy: 'different-controller-this-restart',
    };
    openSessionForWrite(newManifest, rootDir, { resume: true });

    const onDisk = JSON.parse(
      readFileSync(join(rootDir, 'sessions', 's-keep', 'manifest.json'), 'utf-8'),
    ) as SessionManifest;
    expect(onDisk.startedBy).toBe('test-controller');

    // Continue appending — the new line lands AFTER the old one.
    appendEvaluations('s-keep', [makeEval('pol_second', 0.9, 70_000)]);
    const evalLines = readFileSync(
      join(rootDir, 'sessions', 's-keep', 'evaluations.jsonl'),
      'utf-8',
    )
      .trim()
      .split('\n');
    expect(evalLines).toHaveLength(2);
    expect(JSON.parse(evalLines[0]).id).toBe('pol_first');
    expect(JSON.parse(evalLines[1]).id).toBe('pol_second');
  });
});
