/**
 * Runs evaluatePlan (the full solver) against an in-memory seed override
 * and prints the key supported-spend numbers. Never writes any file.
 *
 * Usage:
 *   node --import tsx scripts/plan-eval-query.ts [options]
 *
 * Options:
 *   --retirement-date YYYY-MM-DD
 *   --essential-monthly N
 *   --optional-monthly N
 */

import { initialSeedData } from '../src/data';
import { defaultAssumptions } from '../src/default-assumptions';
import { evaluatePlan, type Plan } from '../src/plan-evaluation';
import { DEFAULT_LEGACY_TARGET_TODAY_DOLLARS } from '../src/legacy-target-cache';
import type { SeedData } from '../src/types';

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      result[argv[i].slice(2)] = argv[i + 1] ?? 'true';
      i++;
    }
  }
  return result;
}

function applyOverrides(base: SeedData, overrides: Record<string, string>): SeedData {
  let data = base;
  if (overrides['retirement-date']) {
    data = { ...data, income: { ...data.income, salaryEndDate: overrides['retirement-date'] } };
  }
  if (overrides['essential-monthly'] !== undefined) {
    data = { ...data, spending: { ...data.spending, essentialMonthly: Number(overrides['essential-monthly']) } };
  }
  if (overrides['optional-monthly'] !== undefined) {
    data = { ...data, spending: { ...data.spending, optionalMonthly: Number(overrides['optional-monthly']) } };
  }
  if (overrides['cash'] !== undefined) {
    data = { ...data, accounts: { ...data.accounts, cash: { ...data.accounts.cash, balance: Number(overrides['cash']) } } };
  }
  return data;
}

const args = parseArgs(process.argv.slice(2));
const overrideKeys = Object.keys(args);
const seed = applyOverrides(initialSeedData, args);

function buildPlan(data: SeedData): Plan {
  return {
    data,
    assumptions: {
      ...defaultAssumptions,
      simulationRuns: 180,
      assumptionsVersion: 'plan-eval-query',
    },
    controls: {
      selectedStressorIds: [],
      selectedResponseIds: [],
      toggles: {
        preserveRoth: false,
        increaseCashBuffer: false,
        avoidRetirementDelayRecommendations: true,
        avoidHomeSaleRecommendations: true,
      },
    },
    preferences: {
      irmaaPosture: 'balanced',
      preserveLifestyleFloor: true,
      timePreference: { ages60to69: 'high', ages70to79: 'medium', ages80plus: 'low' },
      calibration: {
        targetLegacyTodayDollars: DEFAULT_LEGACY_TARGET_TODAY_DOLLARS,
        legacyPriority: 'important',
        successFloorMode: 'balanced',
        minSuccessRate: 0.92,
        optimizationObjective: 'maximize_time_weighted_spending',
      },
      responsePolicy: {
        posture: 'defensive',
        optionalSpendingCutsAllowed: true,
        optionalSpendingFlexPercent: 12,
        travelFlexPercent: 20,
        preserveRothPreference: false,
      },
      runtime: {
        timeoutMs: 120_000,
        finalEvaluationSimulationRuns: 180,
        solverSearchSimulationRuns: 90,
        solverFinalSimulationRuns: 180,
        solverMaxIterations: 14,
        solverDiagnosticsMode: 'core',
        solverEnableSuccessRelaxationProbe: false,
        decisionSimulationRuns: 72,
        decisionScenarioEvaluationLimit: 12,
        decisionEvaluateExcludedScenarios: false,
        stressTestComplexity: 'reduced',
      },
    },
  };
}

const usd = (n: number) => '$' + Math.round(n).toLocaleString();

async function main() {
  console.log('\n=== plan-eval-query ===');
  console.log('Seed files: READ-ONLY — seed-data.json and site files untouched.');

  if (overrideKeys.length > 0) {
    console.log('\nOverrides (applied in memory only):');
    for (const k of overrideKeys) {
      let from = '';
      if (k === 'retirement-date') from = `${initialSeedData.income.salaryEndDate} → `;
      if (k === 'essential-monthly') from = `${initialSeedData.spending.essentialMonthly} → `;
      if (k === 'optional-monthly') from = `${initialSeedData.spending.optionalMonthly} → `;
      console.log(`  --${k}: ${from}${args[k]}`);
    }
  }

  console.log('\nRunning baseline solver...');
  const t0 = Date.now();
  const baselineEval = await evaluatePlan(buildPlan(initialSeedData));
  console.log(`  done (${Date.now() - t0}ms)`);

  let scenarioEval = baselineEval;
  if (overrideKeys.length > 0) {
    console.log('Running scenario solver...');
    const t1 = Date.now();
    scenarioEval = await evaluatePlan(buildPlan(seed));
    console.log(`  done (${Date.now() - t1}ms)`);
  }

  const b = baselineEval;
  const s = scenarioEval;
  const bCal = b.calibration;
  const sCal = s.calibration;

  const sign = (n: number) => (n >= 0 ? '+' : '') + Math.round(n).toLocaleString();
  const signUsd = (n: number) => (n >= 0 ? '+$' : '-$') + Math.round(Math.abs(n)).toLocaleString();

  console.log('\n');

  if (overrideKeys.length > 0) {
    console.log('                              BASELINE        SCENARIO           DELTA');
    console.log('  ' + '-'.repeat(70));
    const retDate = args['retirement-date'] ?? initialSeedData.income.salaryEndDate;
    console.log(`  ${'Retirement date'.padEnd(26)}  ${initialSeedData.income.salaryEndDate.padStart(14)}  ${retDate.padStart(14)}`);
    console.log(`  ${'Plan verdict'.padEnd(26)}  ${b.summary.planVerdict.padStart(14)}  ${s.summary.planVerdict.padStart(14)}`);
    console.log(`  ${'Success rate'.padEnd(26)}  ${(b.summary.successRate * 100).toFixed(1).padStart(13)}%  ${(s.summary.successRate * 100).toFixed(1).padStart(13)}%`);
    console.log('');
    console.log(`  ${'Supported monthly (now)'.padEnd(26)}  ${usd(bCal.supportedMonthlySpendNow).padStart(14)}  ${usd(sCal.supportedMonthlySpendNow).padStart(14)}  ${signUsd(sCal.supportedMonthlySpendNow - bCal.supportedMonthlySpendNow).padStart(12)}`);
    console.log(`  ${'Supported annual (now)'.padEnd(26)}  ${usd(bCal.supportedAnnualSpendNow).padStart(14)}  ${usd(sCal.supportedAnnualSpendNow).padStart(14)}  ${signUsd(sCal.supportedAnnualSpendNow - bCal.supportedAnnualSpendNow).padStart(12)}`);
    console.log(`  ${'User target monthly'.padEnd(26)}  ${usd(bCal.userTargetMonthlySpendNow).padStart(14)}  ${usd(sCal.userTargetMonthlySpendNow).padStart(14)}`);
    console.log(`  ${'Spend gap monthly'.padEnd(26)}  ${usd(bCal.spendGapNowMonthly).padStart(14)}  ${usd(sCal.spendGapNowMonthly).padStart(14)}  ${signUsd(sCal.spendGapNowMonthly - bCal.spendGapNowMonthly).padStart(12)}`);
    console.log('');
    console.log(`  ${'Supported spend 60s'.padEnd(26)}  ${usd(bCal.supportedSpend60s / 12).padStart(13)}/mo  ${usd(sCal.supportedSpend60s / 12).padStart(13)}/mo  ${signUsd((sCal.supportedSpend60s - bCal.supportedSpend60s) / 12).padStart(12)}`);
    console.log(`  ${'Supported spend 70s'.padEnd(26)}  ${usd(bCal.supportedSpend70s / 12).padStart(13)}/mo  ${usd(sCal.supportedSpend70s / 12).padStart(13)}/mo  ${signUsd((sCal.supportedSpend70s - bCal.supportedSpend70s) / 12).padStart(12)}`);
    console.log(`  ${'Supported spend 80+'.padEnd(26)}  ${usd(bCal.supportedSpend80Plus / 12).padStart(13)}/mo  ${usd(sCal.supportedSpend80Plus / 12).padStart(13)}/mo  ${signUsd((sCal.supportedSpend80Plus - bCal.supportedSpend80Plus) / 12).padStart(12)}`);
    console.log('');
    console.log(`  ${'Biggest driver'.padEnd(26)}  ${b.summary.biggestDriver}`);
    console.log(`  ${'Best action (baseline)'.padEnd(26)}  ${b.summary.bestAction}`);
    console.log(`  ${'Best action (scenario)'.padEnd(26)}  ${s.summary.bestAction}`);
  } else {
    console.log('  BASELINE');
    console.log('  ' + '-'.repeat(50));
    console.log(`  ${'Retirement date'.padEnd(26)}  ${initialSeedData.income.salaryEndDate}`);
    console.log(`  ${'Plan verdict'.padEnd(26)}  ${b.summary.planVerdict}`);
    console.log(`  ${'Success rate'.padEnd(26)}  ${(b.summary.successRate * 100).toFixed(1)}%`);
    console.log('');
    console.log(`  ${'Supported monthly (now)'.padEnd(26)}  ${usd(bCal.supportedMonthlySpendNow)}`);
    console.log(`  ${'Supported annual (now)'.padEnd(26)}  ${usd(bCal.supportedAnnualSpendNow)}`);
    console.log(`  ${'User target monthly'.padEnd(26)}  ${usd(bCal.userTargetMonthlySpendNow)}`);
    console.log(`  ${'Spend gap monthly'.padEnd(26)}  ${usd(bCal.spendGapNowMonthly)}`);
    console.log('');
    console.log(`  ${'Supported spend 60s'.padEnd(26)}  ${usd(bCal.supportedSpend60s / 12)}/mo`);
    console.log(`  ${'Supported spend 70s'.padEnd(26)}  ${usd(bCal.supportedSpend70s / 12)}/mo`);
    console.log(`  ${'Supported spend 80+'.padEnd(26)}  ${usd(bCal.supportedSpend80Plus / 12)}/mo`);
    console.log('');
    console.log(`  ${'Biggest driver'.padEnd(26)}  ${b.summary.biggestDriver}`);
    console.log(`  ${'Best action'.padEnd(26)}  ${b.summary.bestAction}`);
  }

  console.log('');
}

main().catch((err) => {
  console.error('plan-eval-query FAILED:', err);
  process.exit(1);
});
