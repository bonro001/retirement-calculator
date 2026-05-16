import { modelReplayPacketFixture } from '../src/model-replay-packets';
import { initialSeedData } from '../src/data';
import { buildNorthStarBudgetFromPath } from '../src/north-star-budget';
import { resolveProtectedReserveGoal } from '../src/protected-reserve';
import { GOLDEN_SCENARIOS } from '../src/verification-scenarios';
import {
  getDefaultVerificationAssumptions,
  runGoldenScenarios,
} from '../src/verification-harness';
import { buildPathResults } from '../src/utils';

const goldenScenarios = runGoldenScenarios(GOLDEN_SCENARIOS).map((report) => ({
  scenarioId: report.scenarioId,
  scenarioName: report.scenarioName,
  pass: report.pass,
  summary: report.summary,
  comparisons: report.comparisons,
  notes: report.notes,
}));

const replayPackets = modelReplayPacketFixture.packets.map((packet) => ({
  id: packet.id,
  label: packet.label,
  modelCompleteness: packet.modelCompleteness,
  inferredAssumptionCount: packet.inferredAssumptions.length,
  simulationSeed: packet.input.assumptions.simulationSeed,
  simulationRuns: packet.input.assumptions.simulationRuns,
  summary: packet.expected.summary,
  ledgerYearCount: packet.expected.yearlyLedger.length,
}));

const currentHouseholdPacket =
  modelReplayPacketFixture.packets.find(
    (packet) => packet.id === modelReplayPacketFixture.$meta.currentHouseholdPacketId,
  ) ?? null;
const currentHouseholdPacketLastRow =
  currentHouseholdPacket?.expected.yearlyLedger[
    currentHouseholdPacket.expected.yearlyLedger.length - 1
  ] ?? null;

const northStarAssumptions = {
  ...getDefaultVerificationAssumptions(),
  simulationRuns: 80,
  simulationSeed: 246810,
  assumptionsVersion: 'verification-snapshot-north-star-v1',
};
const northStarData = structuredClone(initialSeedData);
const [northStarPath] = buildPathResults(northStarData, northStarAssumptions, [], [], {
  pathMode: 'selected_only',
  strategyMode: 'planner_enhanced',
});
const northStarBudget = buildNorthStarBudgetFromPath({
  path: northStarPath,
  year: northStarPath.yearlySeries[0]?.year ?? 2026,
  spendingPath: null,
  fallbackCoreAnnual:
    northStarData.spending.essentialMonthly * 12 +
    northStarData.spending.optionalMonthly * 12 +
    northStarData.spending.annualTaxesInsurance,
  fallbackTravelAnnual: northStarData.spending.travelEarlyRetirementAnnual,
  inflation: northStarAssumptions.inflation,
  legacyTarget: northStarData.goals?.legacyTargetTodayDollars ?? 1_000_000,
  protectedReserve: resolveProtectedReserveGoal(northStarData.goals),
});

process.stdout.write(
  `${JSON.stringify(
    {
      goldenScenarios,
      northStarBudget: {
        source: northStarBudget.source,
        year: northStarBudget.year,
        totalAnnualBudget: northStarBudget.totalAnnualBudget,
        totalMonthlyBudget: northStarBudget.totalMonthlyBudget,
        spendAndHealthAnnual: northStarBudget.spendAndHealthAnnual,
        federalTaxAnnual: northStarBudget.federalTaxAnnual,
        lifestyleAnnual: northStarBudget.lifestyleAnnual,
        protectedReserve: northStarBudget.protectedReserve,
        medianEndingWealth: northStarBudget.medianEndingWealth,
      },
      replayFixture: {
        packetCount: modelReplayPacketFixture.packets.length,
        currentHouseholdPacketId:
          modelReplayPacketFixture.$meta.currentHouseholdPacketId ?? null,
        compatibilityPacketIds:
          modelReplayPacketFixture.$meta.compatibilityPacketIds ?? [],
        currentHouseholdPacket: currentHouseholdPacket
          ? {
              id: currentHouseholdPacket.id,
              legacyTargetTodayDollars:
                currentHouseholdPacket.input.data.goals?.legacyTargetTodayDollars ?? null,
              protectedReserve:
                currentHouseholdPacket.input.data.goals?.protectedReserve ?? null,
              robPlanningEndAge:
                currentHouseholdPacket.input.assumptions.robPlanningEndAge,
              debbiePlanningEndAge:
                currentHouseholdPacket.input.assumptions.debbiePlanningEndAge,
              ledgerYearCount: currentHouseholdPacket.expected.yearlyLedger.length,
              finalYear: currentHouseholdPacketLastRow?.year ?? null,
            }
          : null,
      },
      replayPackets,
    },
    null,
    2,
  )}\n`,
);
