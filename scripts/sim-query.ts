/**
 * CLI scenario tester. Runs the baseline + one override scenario and prints
 * a side-by-side comparison. Uses selected_only pathMode (1 sim path instead
 * of 3) so each run finishes in a few seconds at 1000 trials.
 *
 * Usage:
 *   node --import tsx scripts/sim-query.ts [options]
 *
 * Options:
 *   --retirement-date YYYY-MM-DD   patch income.salaryEndDate
 *   --essential-monthly N          patch spending.essentialMonthly
 *   --optional-monthly N           patch spending.optionalMonthly
 *   --trials N                     simulation run count (default 1000)
 *   --seed N                       RNG seed (default from defaultAssumptions)
 *
 * Example:
 *   node --import tsx scripts/sim-query.ts --retirement-date 2028-04-28
 *   node --import tsx scripts/sim-query.ts --essential-monthly 5500 --optional-monthly 5500
 */

import { initialSeedData } from '../src/data';
import { defaultAssumptions } from '../src/default-assumptions';
import { buildPathResults } from '../src/utils';
import type { SeedData } from '../src/types';

// --- arg parsing ---

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

const args = parseArgs(process.argv.slice(2));

// --- seed data patch ---

function applyOverrides(base: SeedData, overrides: Record<string, string>): SeedData {
  let data = base;

  if (overrides['retirement-date']) {
    data = { ...data, income: { ...data.income, salaryEndDate: overrides['retirement-date'] } };
  }

  if (overrides['essential-monthly'] !== undefined) {
    data = {
      ...data,
      spending: { ...data.spending, essentialMonthly: Number(overrides['essential-monthly']) },
    };
  }

  if (overrides['optional-monthly'] !== undefined) {
    data = {
      ...data,
      spending: { ...data.spending, optionalMonthly: Number(overrides['optional-monthly']) },
    };
  }

  if (overrides['cash'] !== undefined) {
    data = {
      ...data,
      accounts: {
        ...data.accounts,
        cash: { ...data.accounts.cash, balance: Number(overrides['cash']) },
      },
    };
  }

  return data;
}

const overrideKeys = Object.keys(args).filter((k) => k !== 'trials' && k !== 'seed');
const hasOverrides = overrideKeys.length > 0;
const trials = Number(args['trials'] ?? 1000);
const seed = Number(args['seed'] ?? defaultAssumptions.simulationSeed);
const assumptions = { ...defaultAssumptions, simulationRuns: trials, simulationSeed: seed };

const baselineSeed = initialSeedData;
const scenarioSeed = hasOverrides ? applyOverrides(initialSeedData, args) : initialSeedData;

// --- formatters ---

const usd = (n: number) => '$' + Math.round(n).toLocaleString();
const pct = (n: number) => (n * 100).toFixed(1) + '%';

function delta(n: number, asPct = false): string {
  if (Math.abs(n) < 0.0001 && asPct) return '—';
  if (Math.abs(n) < 100 && !asPct) return '—';
  const sign = n >= 0 ? '+' : '';
  if (asPct) return `${sign}${(n * 100).toFixed(1)}pp`;
  return `${sign}${usd(n)}`;
}

function row(label: string, base: string, scen?: string, d?: string) {
  const labelCol = label.padEnd(20);
  const baseCol = base.padStart(14);
  if (!scen) return `  ${labelCol}  ${baseCol}`;
  const scenCol = scen.padStart(14);
  const deltaCol = (d ?? '').padStart(12);
  return `  ${labelCol}  ${baseCol}  ${scenCol}  ${deltaCol}`;
}

// --- run ---

console.log('\n=== sim-query ===');
console.log('Seed files: READ-ONLY — seed-data.json and site files untouched.');
console.log(`Trials: ${trials}  Seed: ${seed}  Date: ${new Date().toISOString().slice(0, 10)}\n`);

if (hasOverrides) {
  console.log('Overrides:');
  for (const k of overrideKeys) {
    let from = '';
    if (k === 'retirement-date') from = `${baselineSeed.income.salaryEndDate} → `;
    if (k === 'essential-monthly') from = `${baselineSeed.spending.essentialMonthly} → `;
    if (k === 'optional-monthly') from = `${baselineSeed.spending.optionalMonthly} → `;
    console.log(`  --${k}: ${from}${args[k]}`);
  }
  console.log('');
}

process.stdout.write('Running baseline...  ');
const t0 = Date.now();
const baselineResults = buildPathResults(baselineSeed, assumptions, [], [], { pathMode: 'selected_only' });
const b = baselineResults[0];
console.log(`${Date.now() - t0}ms`);

let s = b;
if (hasOverrides) {
  process.stdout.write('Running scenario...  ');
  const t1 = Date.now();
  const scenarioResults = buildPathResults(scenarioSeed, assumptions, [], [], { pathMode: 'selected_only' });
  s = scenarioResults[0];
  console.log(`${Date.now() - t1}ms`);
}

console.log('');

if (hasOverrides) {
  const header = row('', 'BASELINE', 'SCENARIO', 'DELTA');
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));
  console.log(row('Retirement date', baselineSeed.income.salaryEndDate, args['retirement-date'] ?? baselineSeed.income.salaryEndDate));
  console.log(row('Success rate', pct(b.successRate), pct(s.successRate), delta(s.successRate - b.successRate, true)));
  console.log(row('Median wealth', usd(b.medianEndingWealth), usd(s.medianEndingWealth), delta(s.medianEndingWealth - b.medianEndingWealth)));
  console.log(row('P10 wealth', usd(b.tenthPercentileEndingWealth), usd(s.tenthPercentileEndingWealth), delta(s.tenthPercentileEndingWealth - b.tenthPercentileEndingWealth)));
  console.log(row('Spending cuts', pct(b.spendingCutRate), pct(s.spendingCutRate), delta(s.spendingCutRate - b.spendingCutRate, true)));
  console.log(row('IRMAA exposure', b.irmaaExposure, s.irmaaExposure));
  console.log(row('Corner risk', b.cornerRisk, s.cornerRisk));
  console.log(row('Inherit. depend.', pct(b.inheritanceDependenceRate), pct(s.inheritanceDependenceRate), delta(s.inheritanceDependenceRate - b.inheritanceDependenceRate, true)));
} else {
  console.log('BASELINE');
  console.log('  ' + '-'.repeat(40));
  console.log(row('Retirement date', baselineSeed.income.salaryEndDate));
  console.log(row('Success rate', pct(b.successRate)));
  console.log(row('Median wealth', usd(b.medianEndingWealth)));
  console.log(row('P10 wealth', usd(b.tenthPercentileEndingWealth)));
  console.log(row('Spending cuts', pct(b.spendingCutRate)));
  console.log(row('IRMAA exposure', b.irmaaExposure));
  console.log(row('Corner risk', b.cornerRisk));
  console.log(row('Inherit. depend.', pct(b.inheritanceDependenceRate)));
}

console.log('');
