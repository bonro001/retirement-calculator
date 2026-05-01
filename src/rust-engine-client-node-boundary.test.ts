import { describe, expect, it } from 'vitest';
import {
  buildEngineCandidateRequest,
  comparePathResults,
  runEngineReference,
  type EngineCandidateRequest,
} from './engine-compare';
import { RustEngineClient } from '../cluster/rust-engine-client';
import { NativeRustEngineClient } from '../cluster/rust-engine-native-client';

describe('RustEngineClient node boundary', () => {
  it('runs a replay-tape request over the persistent Node boundary', { timeout: 30_000 }, async () => {
    const reference = runEngineReference({
      trials: 20,
      mode: 'raw_simulation',
      recordTape: true,
    });
    const client = new RustEngineClient();
    try {
      const response = await client.runCandidateRequest(
        buildEngineCandidateRequest(reference),
      );
      if (!response.path) {
        throw new Error('RustEngineClient expected a full_trace path response');
      }
      const comparison = comparePathResults(reference.path, response.path);

      expect(response.runtime).toBe('rust-replay-candidate');
      expect(comparison.pass).toBe(true);
      expect(comparison.firstDifference).toBeNull();
    } finally {
      await client.close();
    }
  });

  it('can request summary-only output from Rust', { timeout: 30_000 }, async () => {
    const reference = runEngineReference({
      trials: 20,
      mode: 'raw_simulation',
      recordTape: true,
    });
    const client = new RustEngineClient();
    try {
      const summary = await client.runPolicyMiningSummary(
        buildEngineCandidateRequest(reference, 'policy_mining_summary'),
      );

      expect(summary.outputLevel).toBe('policy_mining_summary');
      expect(summary.successRate).toBe(reference.path.successRate);
      expect(summary.endingWealthPercentiles.p50).toBe(
        reference.path.endingWealthPercentiles.p50,
      );
    } finally {
      await client.close();
    }
  });

  it('supports an in-process native adapter contract', () => {
    const compactTapeSessions = new Set<string>();
    const nativeSummaryResponse = (runtime: string, requestJson: string) => {
      const request = JSON.parse(requestJson) as { outputLevel?: string; tape?: unknown };
      expect(request.tape).toBeUndefined();
      return JSON.stringify({
        schemaVersion: 'engine-candidate-response-v1',
        runtime,
        summary:
          request.outputLevel === 'policy_mining_summary'
            ? {
                contractVersion: 'policy-mining-summary-v1',
                outputLevel: 'policy_mining_summary',
                simulationMode: 'raw_simulation',
                successRate: 1,
                medianEndingWealth: 1,
                tenthPercentileEndingWealth: 1,
                endingWealthPercentiles: { p10: 1, p25: 1, p50: 1, p75: 1, p90: 1 },
                spendingCutRate: 0,
                irmaaExposureRate: 0,
                rothDepletionRate: 0,
                annualFederalTaxEstimate: 0,
                failureYearDistribution: [],
                worstOutcome: { endingWealth: 1, success: true, failureYear: null },
                bestOutcome: { endingWealth: 1, success: true, failureYear: null },
                monteCarloMetadata: {
                  seed: 1,
                  trialCount: 1,
                  assumptionsVersion: 'native-adapter-test',
                  planningHorizonYears: 1,
                },
                modelCompleteness: {
                  indicator: 'faithful',
                  inferredAssumptions: [],
                  reconstructedAssumptions: [],
                },
              }
            : undefined,
      });
    };
    const client = new NativeRustEngineClient({
      runCandidateRequestJson: (requestJson) => {
        const request = JSON.parse(requestJson) as { outputLevel?: string };
        return JSON.stringify({
          schemaVersion: 'engine-candidate-response-v1',
          runtime: 'rust-native-test',
          summary:
            request.outputLevel === 'policy_mining_summary'
              ? {
                  contractVersion: 'policy-mining-summary-v1',
                  outputLevel: 'policy_mining_summary',
                  simulationMode: 'raw_simulation',
                  successRate: 1,
                  medianEndingWealth: 1,
                  tenthPercentileEndingWealth: 1,
                  endingWealthPercentiles: { p10: 1, p25: 1, p50: 1, p75: 1, p90: 1 },
                  spendingCutRate: 0,
                  irmaaExposureRate: 0,
                  rothDepletionRate: 0,
                  annualFederalTaxEstimate: 0,
                  failureYearDistribution: [],
                  worstOutcome: { endingWealth: 1, success: true, failureYear: null },
                  bestOutcome: { endingWealth: 1, success: true, failureYear: null },
                  monteCarloMetadata: {
                    seed: 1,
                    trialCount: 1,
                    assumptionsVersion: 'native-adapter-test',
                    planningHorizonYears: 1,
                  },
                  modelCompleteness: {
                    indicator: 'faithful',
                    inferredAssumptions: [],
                    reconstructedAssumptions: [],
                  },
                }
              : undefined,
        });
      },
      registerCandidateSummaryCompactTapeJson: (
        sessionId,
        _tapeMetadataJson,
        trialIndex,
        _trialSeed,
        _ltcEventOccurs,
        _cashflowPresent,
        _marketState,
        marketYears,
        yearFieldCount,
      ) => {
        expect(trialIndex.length).toBe(1);
        expect(marketYears.length).toBe(yearFieldCount);
        compactTapeSessions.add(sessionId);
        return sessionId;
      },
      runCandidateSummaryCompactSessionJson: (requestJson, sessionId) => {
        expect(compactTapeSessions.has(sessionId)).toBe(true);
        return nativeSummaryResponse('rust-native-compact-session-test', requestJson);
      },
      clearCandidateSummaryCompactTapeJson: (sessionId) => {
        compactTapeSessions.delete(sessionId);
        return 'ok';
      },
      runCandidateSummaryCompactJson: (
        requestJson,
        _tapeMetadataJson,
        trialIndex,
        _trialSeed,
        _ltcEventOccurs,
        _cashflowPresent,
        _marketState,
        marketYears,
        yearFieldCount,
      ) => {
        const request = JSON.parse(requestJson) as { outputLevel?: string; tape?: unknown };
        expect(request.tape).toBeUndefined();
        expect(trialIndex.length).toBe(1);
        expect(marketYears.length).toBe(yearFieldCount);
        return nativeSummaryResponse('rust-native-compact-test', requestJson);
      },
    });

    const request: EngineCandidateRequest = {
      schemaVersion: 'engine-candidate-request-v1',
      data: {} as never,
      assumptions: {} as never,
      mode: 'raw_simulation',
      tape: {
        schemaVersion: 'retirement-random-tape-v1',
        generatedBy: 'typescript',
        createdAtIso: '2026-05-01T00:00:00.000Z',
        label: 'native-adapter-test',
        simulationMode: 'raw_simulation',
        seed: 1,
        trialCount: 1,
        planningHorizonYears: 1,
        assumptionsVersion: 'native-adapter-test',
        samplingStrategy: 'mc',
        returnModel: {
          useHistoricalBootstrap: false,
          historicalBootstrapBlockLength: 1,
          useCorrelatedReturns: false,
          equityTailMode: 'normal',
        },
        trials: [
          {
            trialIndex: 0,
            trialSeed: 1,
            ltcEventOccurs: false,
            marketPath: [
              {
                year: 2026,
                yearOffset: 0,
                inflation: 0.02,
                assetReturns: {
                  US_EQUITY: 0.05,
                  INTL_EQUITY: 0.04,
                  BONDS: 0.03,
                  CASH: 0.01,
                },
                bucketReturns: {
                  pretax: 0.04,
                  roth: 0.05,
                  taxable: 0.03,
                  cash: 0.01,
                },
                cashflow: {} as never,
                marketState: 'normal',
              },
            ],
          },
        ],
      },
      outputLevel: 'policy_mining_summary',
    };

    const { summary, timings } = client.runPolicyMiningSummaryWithTiming(request);
    const compact = client.runPolicyMiningSummaryCompactWithTiming(request);
    const compactCached = client.runPolicyMiningSummaryCompactWithTiming(request);

    expect(summary.outputLevel).toBe('policy_mining_summary');
    expect(compact.summary.outputLevel).toBe('policy_mining_summary');
    expect(compactCached.summary.outputLevel).toBe('policy_mining_summary');
    expect(timings.ipcWriteDurationMs).toBe(0);
    expect(compact.timings.ipcWriteDurationMs).toBe(0);
    expect(timings.requestBytes).toBeGreaterThan(0);
    expect(compact.timings.requestBytes).toBeGreaterThan(0);
    expect(compact.timings.compactTapeCacheMisses).toBe(1);
    expect(compact.timings.compactTapeCacheHits).toBe(0);
    expect(compactCached.timings.compactTapeCacheMisses).toBe(0);
    expect(compactCached.timings.compactTapeCacheHits).toBe(1);
    expect(compact.timings.candidateRequestTapeBytes).toBeGreaterThan(0);
    expect(compactCached.timings.candidateRequestTapeBytes).toBe(0);
    expect(compactCached.timings.candidateRequestTapeBytesSaved).toBeGreaterThan(0);
    expect(compactCached.timings.requestBytes).toBeLessThan(
      compact.timings.requestBytes,
    );
  });
});
