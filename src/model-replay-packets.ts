import replayFixture from '../fixtures/model_replay_packets.json';
import type {
  MarketAssumptions,
  PathResult,
  SeedData,
  SimulationStrategyMode,
} from './types';
import { buildPathResults } from './utils';

export interface ReplayYearLedgerRow {
  year: number;
  medianAssets: number;
  tenthPercentileAssets: number;
  medianIncome: number;
  medianSpending: number;
  medianFederalTax: number;
  medianTotalCashOutflow: number;
  medianWithdrawalTotal: number;
  medianRmdAmount: number;
  medianRothConversion: number;
  dominantIrmaaTier: string;
}

export interface ReplayPathSummary {
  id: string;
  label: string;
  simulationMode: SimulationStrategyMode;
  successRate: number;
  medianEndingWealth: number;
  tenthPercentileEndingWealth: number;
  medianFailureYear: number | null;
  annualFederalTaxEstimate: number;
  failureYearDistribution: Array<{
    year: number;
    count: number;
    rate: number;
  }>;
}

export interface ModelReplayPacket {
  id: string;
  label: string;
  modelCompleteness: 'faithful' | 'reconstructed';
  inferredAssumptions: string[];
  input: {
    data: SeedData;
    assumptions: MarketAssumptions;
    selectedStressors: string[];
    selectedResponses: string[];
    options: {
      pathMode: 'selected_only';
      strategyMode: SimulationStrategyMode;
    };
  };
  expected: {
    summary: ReplayPathSummary;
    yearlyLedger: ReplayYearLedgerRow[];
  };
}

export interface ModelReplayPacketFixture {
  $schemaVersion: number;
  $meta: {
    purpose: string;
    capturedOn: string;
    modelCompleteness: 'faithful' | 'reconstructed';
    inferredAssumptions: string[];
    currentHouseholdPacketId?: string;
    compatibilityPacketIds?: string[];
  };
  packets: ModelReplayPacket[];
}

export interface ModelReplayResult {
  packetId: string;
  passed: boolean;
  actual: {
    summary: ReplayPathSummary;
    yearlyLedger: ReplayYearLedgerRow[];
  };
  mismatches: string[];
}

export const modelReplayPacketFixture =
  replayFixture as ModelReplayPacketFixture;

function round(value: number) {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(6));
}

function summarizePath(path: PathResult): ReplayPathSummary {
  return {
    id: path.id,
    label: path.label,
    simulationMode: path.simulationMode,
    successRate: round(path.successRate),
    medianEndingWealth: round(path.medianEndingWealth),
    tenthPercentileEndingWealth: round(path.tenthPercentileEndingWealth),
    medianFailureYear: path.medianFailureYear,
    annualFederalTaxEstimate: round(path.annualFederalTaxEstimate),
    failureYearDistribution: path.failureYearDistribution.map((item) => ({
      year: item.year,
      count: item.count,
      rate: round(item.rate),
    })),
  };
}

function buildYearlyLedger(path: PathResult): ReplayYearLedgerRow[] {
  return path.yearlySeries.map((row) => ({
    year: row.year,
    medianAssets: round(row.medianAssets),
    tenthPercentileAssets: round(row.tenthPercentileAssets),
    medianIncome: round(row.medianIncome),
    medianSpending: round(row.medianSpending),
    medianFederalTax: round(row.medianFederalTax),
    medianTotalCashOutflow: round(row.medianTotalCashOutflow),
    medianWithdrawalTotal: round(row.medianWithdrawalTotal),
    medianRmdAmount: round(row.medianRmdAmount),
    medianRothConversion: round(row.medianRothConversion),
    dominantIrmaaTier: row.dominantIrmaaTier,
  }));
}

function collectMismatches(
  expected: ModelReplayPacket['expected'],
  actual: ModelReplayResult['actual'],
) {
  const mismatches: string[] = [];
  if (JSON.stringify(actual.summary) !== JSON.stringify(expected.summary)) {
    mismatches.push('summary');
  }
  if (
    JSON.stringify(actual.yearlyLedger) !==
    JSON.stringify(expected.yearlyLedger)
  ) {
    mismatches.push('yearlyLedger');
  }
  return mismatches;
}

export function replayModelPacket(packet: ModelReplayPacket): ModelReplayResult {
  const [path] = buildPathResults(
    packet.input.data,
    packet.input.assumptions,
    packet.input.selectedStressors,
    packet.input.selectedResponses,
    packet.input.options,
  );
  const actual = {
    summary: summarizePath(path),
    yearlyLedger: buildYearlyLedger(path),
  };
  const mismatches = collectMismatches(packet.expected, actual);
  return {
    packetId: packet.id,
    passed: mismatches.length === 0,
    actual,
    mismatches,
  };
}

export function replayModelPacketFixture(
  fixture = modelReplayPacketFixture,
): ModelReplayResult[] {
  return fixture.packets.map((packet) => replayModelPacket(packet));
}
