import type { PlanEvaluation } from './plan-evaluation';
import type { SeedData } from './types';
import type {
  SixPackInstrument,
  SixPackSnapshot,
  SixPackStatus,
} from './six-pack-types';
import type { SixPackSpendingContext } from './six-pack-spending';
import { formatCurrency } from './utils';
import { rollupHoldingsToAssetClasses } from './asset-class-mapper';
import type { PortfolioWeatherSnapshot } from './portfolio-weather';

const STALE_LEDGER_DAYS = 7;

function compactCurrency(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return formatCurrency(Math.round(value));
}

function daysBetween(leftIso: string | null, rightIso: string): number | null {
  if (!leftIso) return null;
  const left = new Date(leftIso).getTime();
  const right = new Date(rightIso).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.max(0, (right - left) / 86_400_000);
}

function worseStatus(left: SixPackStatus, right: SixPackStatus): SixPackStatus {
  const rank: Record<SixPackStatus, number> = {
    green: 0,
    unknown: 1,
    amber: 2,
    red: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

function dataFreshness(asOfIso: string | null, snapshotAsOfIso: string, label: string) {
  const ageDays = daysBetween(asOfIso, snapshotAsOfIso);
  return {
    asOfIso,
    label: ageDays === null ? label : `${label} · ${Math.round(ageDays)}d old`,
    stale: ageDays === null ? true : ageDays > STALE_LEDGER_DAYS,
  };
}

function buildLifestylePace(input: {
  spending: SixPackSpendingContext | null;
  asOfIso: string;
}): SixPackInstrument {
  const rule =
    'Green when projected monthly operating spend is at or below 105% of the monthly operating lane; amber at 105-110%; red above 110%.';
  if (!input.spending) {
    return {
      id: 'lifestyle_pace',
      label: 'Lifestyle Pace',
      question: 'Is normal life inside plan?',
      status: 'unknown',
      trend: 'none',
      headline: 'NO LEDGER',
      reason: 'Spending ledger data is unavailable.',
      rule,
      detail: 'Load the local spending ledger before trusting the monthly lifestyle gauge.',
      actionLabel: 'Open Spending',
      sourceFreshness: dataFreshness(null, input.asOfIso, 'ledger unavailable'),
      diagnostics: {},
    };
  }

  const budget = input.spending.monthlyOperatingBudget;
  const projected = input.spending.monthlyOperatingProjected;
  const ratio = budget > 0 ? projected / budget : 0;
  const status: SixPackStatus =
    input.spending.ledgerStatus !== 'loaded'
      ? 'unknown'
      : ratio <= 1.05
        ? 'green'
        : ratio <= 1.1
          ? 'amber'
          : 'red';
  const trend = ratio <= 0.97 ? 'down' : ratio >= 1.03 ? 'up' : 'flat';
  const overUnder = Math.abs(projected - budget);

  return {
    id: 'lifestyle_pace',
    label: 'Lifestyle Pace',
    question: 'Is normal life inside plan?',
    status,
    trend,
    headline: status === 'green' ? 'ON PLAN' : status === 'amber' ? 'WATCH' : status === 'red' ? 'TIGHTEN' : 'NO LEDGER',
    frontMetric: `${compactCurrency(input.spending.monthlyOperatingSpent)} / ${compactCurrency(budget)} mo`,
    reason:
      status === 'green'
        ? 'Monthly operating spend is inside the modeled lifestyle lane.'
        : status === 'amber'
          ? `Projected monthly operating spend is about ${formatCurrency(overUnder)} above the lane.`
          : status === 'red'
            ? `Projected monthly operating spend is more than 10% above the lane.`
            : 'Spending ledger data is not loaded.',
    rule,
    detail: `Current operating spend is ${formatCurrency(input.spending.monthlyOperatingSpent)}; projected month-end is ${formatCurrency(projected)} against a ${formatCurrency(budget)} monthly operating lane.`,
    actionLabel: 'Open Spending',
    sourceFreshness: dataFreshness(input.spending.summary.asOfIso, input.asOfIso, 'spending ledger'),
    diagnostics: {
      monthlyOperatingBudget: budget,
      monthlyOperatingSpent: input.spending.monthlyOperatingSpent,
      monthlyOperatingProjected: projected,
      monthElapsedPercent: Number(
        (input.spending.summary.intermediateCalculations.elapsedShare * 100).toFixed(2),
      ),
      projectedToBudgetRatio: Number(ratio.toFixed(4)),
      transactionCount: input.spending.transactionCount,
    },
  };
}

function buildCashRunway(input: { data: SeedData; asOfIso: string }): SixPackInstrument {
  const targetMonths = 18;
  const essentialWithFixedMonthly =
    input.data.spending.essentialMonthly + input.data.spending.annualTaxesInsurance / 12;
  const liquidFromBucket = (bucket: keyof SeedData['accounts']) => {
    const account = input.data.accounts[bucket];
    if (!account) return 0;
    const exposure = rollupHoldingsToAssetClasses(
      account.targetAllocation ?? {},
      input.data.rules.assetClassMappingAssumptions,
    );
    return Math.max(0, account.balance) * (exposure.CASH + exposure.BONDS);
  };
  const liquidRunway =
    liquidFromBucket('cash') +
    liquidFromBucket('taxable') +
    liquidFromBucket('pretax') +
    liquidFromBucket('roth') +
    liquidFromBucket('hsa');
  const targetCashRunway = essentialWithFixedMonthly * targetMonths;
  const directCashBalance = input.data.accounts.cash.balance;
  const investmentLiquidSleeves = Math.max(0, liquidRunway - directCashBalance);
  const months = essentialWithFixedMonthly > 0 ? liquidRunway / essentialWithFixedMonthly : 0;
  const status: SixPackStatus = months >= 18 ? 'green' : months >= 12 ? 'amber' : 'red';

  return {
    id: 'cash_runway',
    label: 'Cash Runway',
    question: 'Can we avoid selling?',
    status,
    trend: 'flat',
    headline: status === 'green' ? 'COVERED' : status === 'amber' ? 'WATCH' : 'SHORT',
    reason:
      status === 'green'
        ? 'Cash, money-market, and bond sleeves meet the 18-month runway target.'
        : status === 'amber'
          ? 'Runway is below target but still above the 12-month action line.'
          : 'Runway is below the 12-month action line.',
    rule: 'Green at 18+ months of essential plus fixed spending in cash, money-market, and bond sleeves; amber at 12-18 months; red below 12 months.',
    detail: `Runway liquidity is ${formatCurrency(liquidRunway)} against an ${formatCurrency(targetCashRunway)} target.`,
    actionLabel: 'Open Accounts',
    sourceFreshness: dataFreshness(input.asOfIso, input.asOfIso, 'seed accounts'),
    diagnostics: {
      runwayMonths: Number(months.toFixed(1)),
      currentRunwayLiquidity: Number(liquidRunway.toFixed(2)),
      targetCashRunway: Number(targetCashRunway.toFixed(2)),
      directCashBalance,
      investmentLiquidSleeves: Number(investmentLiquidSleeves.toFixed(2)),
    },
  };
}

function buildPortfolioWeather(input: {
  weather: PortfolioWeatherSnapshot | null;
  asOfIso: string;
}): SixPackInstrument {
  if (input.weather?.available) {
    const coverageLimited = input.weather.quoteCoveragePercent < 80;
    const status: SixPackStatus =
      input.weather.changePercent <= -5
        ? 'red'
        : input.weather.changePercent < -1 || coverageLimited
          ? 'amber'
          : 'green';
    const headline =
      status === 'red'
        ? 'STORM'
        : input.weather.changePercent < -1
          ? 'HEADWIND'
          : input.weather.changePercent > 1
            ? 'TAILWIND'
            : 'STEADY';
    const signedChange =
      input.weather.changeDollars >= 0
        ? `up ${formatCurrency(input.weather.changeDollars)}`
        : `down ${formatCurrency(Math.abs(input.weather.changeDollars))}`;
    const heldAtImportNote =
      input.weather.heldAtImportValue > 0
        ? ` ${formatCurrency(input.weather.heldAtImportValue)} is held at last-import value (${formatCurrency(input.weather.cashValueHeldAtImport)} cash or money market, ${formatCurrency(input.weather.missingQuoteValueHeldAtImport + input.weather.missingShareValueHeldAtImport)} unpriced), so cash sweeps, contributions, and unquoted holdings can move the next Fidelity export.`
        : '';
    return {
      id: 'portfolio_weather',
      label: 'Portfolio Weather',
      question: 'Tailwind or storm?',
      status,
      trend:
        input.weather.changePercent > 1
          ? 'up'
          : input.weather.changePercent < -1
            ? 'down'
            : 'flat',
      headline,
      reason:
        status === 'green'
          ? 'Quoted market holdings are steady or higher since the last Fidelity import.'
          : status === 'amber'
            ? coverageLimited
              ? 'Quote coverage is incomplete, so the weather read is worth checking.'
              : 'Markets are a headwind versus the last Fidelity import.'
            : 'Estimated market movement is a storm-level drawdown versus the last Fidelity import.',
      rule: 'Green when estimated value is no worse than 1% below the last import with at least 80% quote coverage; amber from -1% to -5% or limited coverage; red below -5%.',
      detail: `Estimated value is ${formatCurrency(input.weather.estimatedValue)}, ${signedChange} (${input.weather.changePercent.toFixed(2)}%) versus the last Fidelity import value of ${formatCurrency(input.weather.importValue)}.${heldAtImportNote}`,
      actionLabel: 'Open Accounts',
      sourceFreshness: dataFreshness(input.weather.quoteAsOfIso, input.asOfIso, 'market quotes'),
      diagnostics: {
        importValue: input.weather.importValue,
        estimatedValue: input.weather.estimatedValue,
        changeDollars: input.weather.changeDollars,
        changePercent: input.weather.changePercent,
        quoteCoveragePercent: input.weather.quoteCoveragePercent,
        quotedImportValue: input.weather.quotedImportValue,
        quotedEstimatedValue: input.weather.quotedEstimatedValue,
        cashValueHeldAtImport: input.weather.cashValueHeldAtImport,
        missingQuoteValueHeldAtImport: input.weather.missingQuoteValueHeldAtImport,
        missingShareValueHeldAtImport: input.weather.missingShareValueHeldAtImport,
        heldAtImportValue: input.weather.heldAtImportValue,
        missingQuoteCount: input.weather.missingQuoteSymbols.length,
        missingShareCount: input.weather.missingShareSymbols.length,
        importAsOfDate: input.weather.importAsOfDate,
      },
    };
  }

  return {
    id: 'portfolio_weather',
    label: 'Portfolio Weather',
    question: 'Tailwind or storm?',
    status: 'unknown',
    trend: 'none',
    headline: 'NO WEATHER',
    reason: 'Latest holdings exist, but live quote/current-value wiring is not active yet.',
    rule: 'Green for material appreciation/tailwind since last import, amber for moderate drawdown/headwind, red for storm drawdown. Exact thresholds must be wired after quote history is available.',
    detail:
      'Next phase preserves shares and import price, fetches current quotes, and compares estimated current value against the last import.',
    actionLabel: 'Wire Quotes',
    sourceFreshness: dataFreshness(null, input.asOfIso, 'quotes unavailable'),
    diagnostics: {
      quotePipelineAvailable: false,
    },
  };
}

function buildPlanIntegrity(input: {
  evaluation: PlanEvaluation | null;
  evaluationCapturedAtIso: string | null;
  asOfIso: string;
}): SixPackInstrument {
  const rule =
    'Green when the latest plan evaluation is strong and success is at least 80%; amber from 70-80% or when trust checks need review; red below 70%.';
  if (!input.evaluation) {
    return {
      id: 'plan_integrity',
      label: 'Plan Integrity',
      question: 'Does retirement still close?',
      status: 'unknown',
      trend: 'none',
      headline: 'NO RUN',
      reason: 'No current unified plan evaluation is available.',
      rule,
      detail: 'Run plan analysis before treating this puck as trustworthy.',
      actionLabel: 'Run Plan',
      sourceFreshness: dataFreshness(null, input.asOfIso, 'plan unavailable'),
      diagnostics: {},
    };
  }

  const successRate = input.evaluation.summary.successRate;
  const trustPanel = input.evaluation.trustPanel;
  const trustNeedsReview = trustPanel ? !trustPanel.safeToRely : false;
  const status: SixPackStatus =
    successRate < 0.7 ? 'red' : successRate < 0.8 || trustNeedsReview ? 'amber' : 'green';

  return {
    id: 'plan_integrity',
    label: 'Plan Integrity',
    question: 'Is long-range retirement funded?',
    status,
    trend: 'flat',
    headline:
      status === 'green'
        ? 'FUNDED'
        : status === 'amber'
          ? 'WATCH'
          : 'AT RISK',
    frontMetric: `${Math.round(successRate * 100)}%`,
    reason:
      status === 'green'
        ? 'Latest retirement reading remains inside the planned confidence lane.'
        : status === 'amber'
          ? 'Plan success or trust checks need attention before calling this fully clear.'
          : 'Latest success reading is below the action threshold.',
    rule,
    detail: `Latest plan success is ${Math.round(successRate * 100)}% with verdict ${input.evaluation.summary.planVerdict}. ${trustPanel?.summary ?? 'Trust panel unavailable.'}`,
    actionLabel: 'Open Cockpit',
    sourceFreshness: dataFreshness(input.evaluationCapturedAtIso, input.asOfIso, 'plan evaluation'),
    diagnostics: {
      successRate,
      planVerdict: input.evaluation.summary.planVerdict,
      safeToRely: trustPanel?.safeToRely ?? null,
      trustConfidence: trustPanel?.confidence ?? null,
    },
  };
}

function buildTaxCliffs(input: {
  evaluation: PlanEvaluation | null;
  evaluationCapturedAtIso: string | null;
  asOfIso: string;
}): SixPackInstrument {
  const outlook = input.evaluation?.summary.irmaaOutlook ?? null;
  const normalized = outlook?.toLowerCase() ?? '';
  const status: SixPackStatus = !outlook
    ? 'unknown'
    : normalized.includes('frequent') || normalized.includes('surcharge')
      ? 'amber'
      : 'green';

  return {
    id: 'tax_cliffs',
    label: 'Tax / ACA / IRMAA',
    question: 'Are cliffs still clear?',
    status,
    trend: 'flat',
    headline: status === 'green' ? 'CLEAR' : status === 'amber' ? 'WATCH' : 'NO RUN',
    reason:
      status === 'green'
        ? 'Latest model does not show meaningful cliff pressure.'
        : status === 'amber'
          ? 'Latest IRMAA or tax outlook has pressure worth watching.'
          : 'Tax cliff projection is not available yet.',
    rule: 'Green when the current plan reports no meaningful ACA/IRMAA pressure; amber when modeled surcharge or cliff pressure appears; red reserved for explicit current-year breach once MAGI projection is wired.',
    detail: outlook ?? 'Run plan analysis to populate tax and healthcare cliff status.',
    actionLabel: 'Open Taxes',
    sourceFreshness: dataFreshness(input.evaluationCapturedAtIso, input.asOfIso, 'plan evaluation'),
    diagnostics: {
      irmaaOutlook: outlook,
    },
  };
}

function buildWatchItems(input: {
  spending: SixPackSpendingContext | null;
  asOfIso: string;
}): SixPackInstrument {
  const escrowSqueeze = input.spending
    ? Math.max(0, input.spending.annualEscrowActualSpend - input.spending.annualEscrowPlannedBudget)
    : 0;
  const status: SixPackStatus = input.spending ? 'green' : 'unknown';
  return {
    id: 'watch_items',
    label: 'Watch Items',
    question: 'Anything waking up?',
    status,
    trend: 'flat',
    headline: status === 'green' ? 'QUIET' : 'NO LEDGER',
    reason:
      status === 'green'
        ? escrowSqueeze > 0
          ? 'Annual escrow is above estimate, but it has been absorbed into the adaptive monthly lane.'
          : 'No modeled watch item is currently asking for attention.'
        : 'Watch rules need the spending ledger before they can be trusted.',
    rule: 'Green when known watch items are quiet or already absorbed into the current monthly lane; amber when drift exists outside the lane; red reserved for action-required items.',
    detail:
      status === 'green'
        ? escrowSqueeze > 0
          ? `Annual escrow actuals are ${formatCurrency(escrowSqueeze)} above estimate, and the monthly operating lane is already reduced around that swing.`
          : 'Current watch list includes annual escrow squeeze, model trust, and data freshness.'
        : 'Load the local spending ledger to evaluate watch items.',
    actionLabel: undefined,
    sourceFreshness: dataFreshness(input.spending?.summary.asOfIso ?? input.asOfIso, input.asOfIso, 'watch rules'),
    diagnostics: {
      annualEscrowSqueeze: escrowSqueeze,
    },
  };
}

export function buildSixPackSnapshot(input: {
  data: SeedData;
  spending: SixPackSpendingContext | null;
  portfolioWeather: PortfolioWeatherSnapshot | null;
  evaluation: PlanEvaluation | null;
  evaluationCapturedAtIso: string | null;
  asOfIso: string;
}): SixPackSnapshot {
  const instruments: SixPackInstrument[] = [
    buildLifestylePace({ spending: input.spending, asOfIso: input.asOfIso }),
    buildCashRunway({ data: input.data, asOfIso: input.asOfIso }),
    buildPortfolioWeather({ weather: input.portfolioWeather, asOfIso: input.asOfIso }),
    buildPlanIntegrity({
      evaluation: input.evaluation,
      evaluationCapturedAtIso: input.evaluationCapturedAtIso,
      asOfIso: input.asOfIso,
    }),
    buildTaxCliffs({
      evaluation: input.evaluation,
      evaluationCapturedAtIso: input.evaluationCapturedAtIso,
      asOfIso: input.asOfIso,
    }),
    buildWatchItems({ spending: input.spending, asOfIso: input.asOfIso }),
  ];

  const counts: Record<SixPackStatus, number> = {
    green: 0,
    amber: 0,
    red: 0,
    unknown: 0,
  };
  const overallStatus = instruments.reduce<SixPackStatus>((status, instrument) => {
    counts[instrument.status] += 1;
    return worseStatus(status, instrument.status);
  }, 'green');

  const actionRequired = counts.red > 0;
  const summary =
    counts.red > 0
      ? 'ACTION NEEDED'
      : counts.amber > 0
        ? `${counts.amber} WATCH`
        : counts.unknown > 0
          ? `${counts.unknown} UNKNOWN`
          : 'ALL GREEN';

  return {
    version: 'six_pack_v1',
    asOfIso: input.asOfIso,
    overallStatus,
    summary,
    counts,
    actionRequired,
    instruments,
  };
}
