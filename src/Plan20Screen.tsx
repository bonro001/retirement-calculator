import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PlanningStateExportCompact } from './planning-export';
import { useAppStore } from './store';
import type { MarketAssumptions, PathResult, SeedData } from './types';
import { formatCurrency, formatPercent } from './utils';
import { usePlanningExportPayload } from './usePlanningExportPayload';
import { SpendVsSafetyScreen } from './SpendVsSafetyScreen';
import { PortfolioHistoryCard } from './PortfolioHistoryCard';
import { TimeAsSafetyPanel } from './TimeAsSafety';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import { loadTradeBuilderFromCache, saveTradeBuilderToCache } from './trade-builder-cache';
import { runSweepBatch, type SweepPoolHandle } from './sweep-worker-pool';
import type { SweepPointInput } from './sweep-worker-types';

type CompactOutcome = Exclude<PlanningStateExportCompact['activeSimulationOutcome'], PathResult>;

interface StorySection {
  id: 'early' | 'middle' | 'late';
  eyebrow: string;
  title: string;
  body: string;
}

interface GuardrailCardData {
  id:
    | 'irmaa_threshold'
    | 'conversion_overshoot'
    | 'income_stacking'
    | 'spending_flexibility'
    | 'inheritance_dependence';
  icon: string;
  title: string;
  explanation: string;
  watchLine?: string;
}

interface WalkthroughYearCard {
  year: number;
  headline: string;
  supporting?: string;
  notice?: string;
}

interface BridgeYearData {
  year: number;
  cash: number;
  taxable: number;
  pretax: number;
  roth: number;
  total: number;
  remainingCashBuffer: number;
  remainingLiquidBuffer: number;
  iraRelianceRate: number;
  highRisk: boolean;
  riskLabels: string[];
}

interface BridgeRiskCallout {
  year: number;
  title: string;
  detail: string;
}

interface BridgeStressSummary {
  stressedSuccessRate: number;
  successRateChange: number;
  bufferTimingLabel: string;
  detail: string;
}

interface TradeBuilderScenarioResult {
  successRate: number;
  irmaaExposureRate: number;
  spendingCutRate: number;
  medianEndingWealth: number;
}

interface TradeBuilderOption {
  id: string;
  title: string;
  description: string;
  requiredChange: string;
  successRate: number;
  irmaaExposureRate: number;
  spendingCutRate: number;
  medianEndingWealth: number;
  disruptionScore: number;
  simplicityScore: number;
  successRateDelta: number;
  irmaaExposureDelta: number;
  guardrailRelianceDelta: number;
}

function formatConstraintLabel(value: string) {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatPercentPointDelta(value: number) {
  const points = value * 100;
  const sign = points > 0 ? '+' : '';
  return `${sign}${points.toFixed(1)} pts`;
}

function formatSignedCurrencyDelta(value: number) {
  const rounded = Math.round(value);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${formatCurrency(rounded)}`;
}

function formatApproxThousands(value: number) {
  const roundedThousands = Math.round(value / 1_000);
  return `about $${roundedThousands}K`;
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function cloneSeedData<T>(value: T): T {
  return structuredClone(value);
}

// ---- This Year's Focus ------------------------------------------------------

type FocusPhase = 'accumulate' | 'glidepath' | 'bridge' | 'rmd-runway' | 'distribute';

interface ThisYearsFocus {
  phase: FocusPhase;
  phaseLabel: string;
  headline: string;
  actions: string[];
  why: string;
}

function getHouseholdBirthdates(data: SeedData): string[] {
  const hh = data.household as Record<string, unknown>;
  const candidates = [hh.robBirthDate, hh.debbieBirthDate];
  return candidates.filter((value): value is string => typeof value === 'string');
}

function getSoonestSocialSecurityClaimYear(data: SeedData): number | null {
  const ss = data.income.socialSecurity as
    | Array<{ person?: string; claimAge?: number }>
    | undefined;
  if (!Array.isArray(ss) || ss.length === 0) return null;
  const hh = data.household as Record<string, unknown>;
  const personBirth: Record<string, string | undefined> = {
    rob: typeof hh.robBirthDate === 'string' ? hh.robBirthDate : undefined,
    debbie: typeof hh.debbieBirthDate === 'string' ? hh.debbieBirthDate : undefined,
  };
  const claimYears: number[] = [];
  for (const entry of ss) {
    if (typeof entry.claimAge !== 'number') continue;
    const bd = entry.person ? personBirth[entry.person] : undefined;
    if (!bd) continue;
    const bdYear = new Date(bd).getUTCFullYear();
    if (!Number.isFinite(bdYear)) continue;
    claimYears.push(bdYear + entry.claimAge);
  }
  if (claimYears.length === 0) return null;
  return Math.min(...claimYears);
}

function getRmdStartYear(data: SeedData): number | null {
  // SECURE 2.0: RMD age 73 for those turning 73 in 2023–2032, 75 for those born
  // 1960 or later.
  const birthdates = getHouseholdBirthdates(data);
  if (birthdates.length === 0) return null;
  const rmdYears = birthdates.map((bd) => {
    const bdYear = new Date(bd).getUTCFullYear();
    if (!Number.isFinite(bdYear)) return Number.POSITIVE_INFINITY;
    const rmdAge = bdYear >= 1960 ? 75 : 73;
    return bdYear + rmdAge;
  });
  const soonest = Math.min(...rmdYears);
  return Number.isFinite(soonest) ? soonest : null;
}

function buildThisYearsFocus(data: SeedData, today: Date = new Date()): ThisYearsFocus {
  const todayYear = today.getUTCFullYear();
  const salaryEnd = data.income.salaryEndDate ? new Date(data.income.salaryEndDate) : null;
  const monthsToRetirement =
    salaryEnd && !Number.isNaN(salaryEnd.getTime())
      ? (salaryEnd.getUTCFullYear() - todayYear) * 12 +
        (salaryEnd.getUTCMonth() - today.getUTCMonth())
      : Number.POSITIVE_INFINITY;
  const retirementYear = salaryEnd?.getUTCFullYear() ?? null;
  const ssClaimYear = getSoonestSocialSecurityClaimYear(data);
  const rmdStartYear = getRmdStartYear(data);
  const retired = retirementYear !== null && todayYear >= retirementYear && monthsToRetirement <= 0;

  // Phase detection
  let phase: FocusPhase;
  if (!retired && monthsToRetirement > 12) {
    phase = 'accumulate';
  } else if (!retired) {
    phase = 'glidepath';
  } else if (ssClaimYear !== null && todayYear < ssClaimYear) {
    phase = 'bridge';
  } else if (rmdStartYear !== null && todayYear < rmdStartYear) {
    phase = 'rmd-runway';
  } else {
    phase = 'distribute';
  }

  const monthsFmt = (m: number) => {
    if (!Number.isFinite(m) || m < 0) return 'soon';
    const years = Math.floor(m / 12);
    const remaining = m % 12;
    if (years === 0) return `${remaining} month${remaining === 1 ? '' : 's'}`;
    if (remaining === 0) return `${years} year${years === 1 ? '' : 's'}`;
    return `${years}y ${remaining}m`;
  };

  switch (phase) {
    case 'accumulate':
      return {
        phase,
        phaseLabel: 'Accumulate',
        headline: `Retirement is ${monthsFmt(monthsToRetirement)} out. Every pre-tax dollar you shovel in now is one you don't pull taxed later.`,
        actions: [
          'Max the 401(k) — including the catch-up if you\'re 50+.',
          'Fund the HSA in full; it is the most tax-efficient dollar in the plan.',
          'Pre-build the taxable bridge bucket so early-retirement spending doesn\'t force pretax withdrawals.',
        ],
        why: retirementYear
          ? `You retire in ${retirementYear}. The glidepath re-risk starts roughly 12 months before that — after which the focus shifts from contributing to de-risking.`
          : 'These contribution years compound into the low-income conversion window ahead.',
      };
    case 'glidepath':
      return {
        phase,
        phaseLabel: 'Glidepath',
        headline: `You retire in about ${monthsFmt(Math.max(0, monthsToRetirement))}. The highest-leverage move left is getting the allocation right before you depend on it.`,
        actions: [
          'Rebalance toward your target retirement allocation; don\'t let a hot year leave you over-equity into retirement.',
          'Build a 2-year cash/short-bond reserve covering essential spending.',
          'Finalize the Roth-conversion schedule for the first clean low-income tax year.',
        ],
        why: 'The first five retirement years carry sequence-of-returns risk. An allocation fix now costs nothing; a bad year after retirement costs real safety.',
      };
    case 'bridge':
      return {
        phase,
        phaseLabel: 'Bridge',
        headline: 'You\'re in the low-tax bridge window — the cheapest years of your retirement to shape your tax future.',
        actions: [
          'Execute the scheduled Roth conversions up to your IRMAA ceiling.',
          'Pull from taxable accounts first to keep MAGI low.',
          'Confirm ACA subsidy eligibility each year and track MAGI vs. the cliff.',
        ],
        why: ssClaimYear
          ? `Social Security starts in ${ssClaimYear}. Every conversion dollar you move now is a dollar that never becomes an RMD later.`
          : 'Every conversion dollar you move now is a dollar that never becomes an RMD later.',
      };
    case 'rmd-runway':
      return {
        phase,
        phaseLabel: 'RMD runway',
        headline: 'Social Security is on; RMDs aren\'t yet. This is your last window with real control over your tax bracket.',
        actions: [
          'Finish Roth conversions before RMDs force bracket creep.',
          'Lock SS and pension withholding to avoid safe-harbor surprises.',
          'Review QCDs if charitable giving is in the plan — they\'re about to become the best tool you have.',
        ],
        why: rmdStartYear
          ? `RMDs begin ${rmdStartYear}. Once they start, your bracket is largely set for you; conversions after that point cost more tax per dollar moved.`
          : 'Once RMDs start, your bracket is largely set for you; conversions after that point cost more tax per dollar moved.',
      };
    case 'distribute':
    default:
      return {
        phase,
        phaseLabel: 'Distribute',
        headline: 'The plan is in drawdown. The focus shifts from shaping tax years to discipline and legacy.',
        actions: [
          'Satisfy this year\'s RMD on schedule; don\'t leave it for Q4.',
          'Use QCDs for any planned charitable giving — it reduces MAGI dollar-for-dollar.',
          'Rebalance for longevity and beneficiaries, not for growth.',
        ],
        why: 'Most of the plan\'s tax levers are behind you. What\'s left is executing the drawdown cleanly and preserving flexibility for the unexpected.',
      };
  }
}


function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function shiftDateYears(value: string, years: number) {
  const next = new Date(value);
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next.toISOString();
}

function getDeltaTone(value: number, kind: 'percent' | 'currency') {
  if (kind === 'percent' && Math.abs(value) < 0.005) {
    return {
      className: 'text-stone-700',
      detail: 'No meaningful change',
    };
  }
  if (value > 0) {
    return {
      className: 'text-emerald-700',
      detail: 'Planner ahead of raw',
    };
  }
  if (value < 0) {
    return {
      className: 'text-red-700',
      detail: 'Planner behind raw',
    };
  }
  return {
    className: 'text-stone-700',
    detail: 'No meaningful change',
  };
}

function getCompactFirstExecutedConversion(outcome: CompactOutcome) {
  const first = outcome.simulationDiagnostics.rothConversionTracePath.find(
    (entry) => entry.conversionExecuted || entry.amount > 0,
  );
  if (!first) {
    return {
      year: null,
      amount: null,
      reason: null as string | null,
      magiBefore: null as number | null,
      magiAfter: null as number | null,
    };
  }
  return {
    year: first.year,
    amount: first.amount,
    reason: first.reason || first.conversionReason || null,
    magiBefore: first.rawMAGI,
    magiAfter: first.rawMAGI + first.magiEffect,
  };
}

function getCompactTotalConversions(outcome: CompactOutcome) {
  return outcome.simulationDiagnostics.conversionPath.reduce(
    (total, entry) => total + entry.value,
    0,
  );
}

function getCompactPretaxDepletionYear(outcome: CompactOutcome) {
  const threshold = 1_000;
  const depletionYear = outcome.yearlySeries.find(
    (entry, index) =>
      entry.medianPretaxBalanceAfterContributions <= threshold &&
      outcome.yearlySeries
        .slice(index)
        .every((laterEntry) => laterEntry.medianPretaxBalanceAfterContributions <= threshold),
  );
  return depletionYear?.year ?? null;
}

function getFirstRmdYear(outcome: CompactOutcome) {
  return outcome.yearlySeries.find((entry) => entry.medianRmdAmount > 0)?.year ?? null;
}

function buildAssetChartData(outcome: CompactOutcome) {
  return outcome.yearlySeries.map((entry) => ({
    year: entry.year,
    assets: entry.medianAssets,
  }));
}

function buildMagiChartData(outcome: CompactOutcome, irmaaThreshold: number) {
  const nearThresholdFloor = Math.max(0, irmaaThreshold - 15_000);
  return outcome.yearlySeries.map((entry) => {
    const nearThreshold = entry.medianMagi >= nearThresholdFloor;
    return {
      year: entry.year,
      magi: entry.medianMagi,
      threshold: irmaaThreshold,
      nearThresholdMagi: nearThreshold ? entry.medianMagi : null,
    };
  });
}

function buildConversionChartData(outcome: CompactOutcome, irmaaThreshold: number) {
  const nearThresholdFloor = Math.max(0, irmaaThreshold - 15_000);
  return outcome.yearlySeries.map((entry) => ({
    year: entry.year,
    amount: entry.medianRothConversion,
    reason: entry.dominantRothConversionReason,
    magi: entry.medianMagi,
    nearThreshold:
      entry.medianRothConversion > 0 && entry.medianMagi >= nearThresholdFloor,
  }));
}

function buildWithdrawalMixChartData(outcome: CompactOutcome) {
  return outcome.simulationDiagnostics.withdrawalPath.map((entry) => ({
    year: entry.year,
    cash: entry.cash,
    taxable: entry.taxable,
    pretax: entry.ira401k,
    roth: entry.roth,
  }));
}

function normalizePersonLabel(value: string) {
  return value.trim().toLowerCase();
}

function getBirthYearForPerson(
  household: PlanningStateExportCompact['household'],
  person: string,
) {
  const normalized = normalizePersonLabel(person);
  if (normalized.includes('rob')) {
    return new Date(household.robBirthDate).getUTCFullYear();
  }
  if (normalized.includes('debbie') || normalized.includes('deb')) {
    return new Date(household.debbieBirthDate).getUTCFullYear();
  }
  return null;
}

function getFirstSocialSecurityYear(payload: PlanningStateExportCompact) {
  const claimYears = payload.income.socialSecurity
    .map((entry) => {
      const birthYear = getBirthYearForPerson(payload.household, entry.person);
      return birthYear === null ? null : birthYear + entry.claimAge;
    })
    .filter((value): value is number => typeof value === 'number');
  return claimYears.length ? Math.min(...claimYears) : null;
}

function buildBridgeAnalysis(input: {
  payload: PlanningStateExportCompact;
  activeOutcome: CompactOutcome;
}) {
  const retirementYear = input.payload.income.retirementYear;
  const firstSocialSecurityYear = getFirstSocialSecurityYear(input.payload);
  if (firstSocialSecurityYear === null || firstSocialSecurityYear <= retirementYear) {
    return {
      retirementYear,
      firstSocialSecurityYear,
      bridgeYears: [] as BridgeYearData[],
      averageAnnualSpend: 0,
      primaryFundingSources: [] as string[],
      safeIndicator: {
        label: 'stable',
        tone: 'good' as const,
        detail: 'Social Security begins right away or there is no visible bridge window to fund.',
      },
      summary:
        'There is little or no gap between retirement and Social Security in the current plan.',
      keyInsights: [] as string[],
      riskSignals: [] as string[],
      riskCallouts: [] as BridgeRiskCallout[],
    };
  }

  const withdrawalByYear = new Map(
    input.activeOutcome.simulationDiagnostics.withdrawalPath.map((entry) => [entry.year, entry]),
  );
  const bridgeSeries = input.activeOutcome.yearlySeries.filter(
    (entry) => entry.year >= retirementYear && entry.year < firstSocialSecurityYear,
  );
  const startCash = input.payload.assets.byBucket.cash;
  const startTaxable = input.payload.assets.byBucket.taxable;
  let cumulativeCash = 0;
  let cumulativeTaxable = 0;

  const bridgeYears = bridgeSeries.map((entry, index, allEntries) => {
    const withdrawal = withdrawalByYear.get(entry.year);
    const cash = withdrawal?.cash ?? 0;
    const taxable = withdrawal?.taxable ?? 0;
    const pretax = withdrawal?.ira401k ?? 0;
    const roth = withdrawal?.roth ?? 0;
    const total = cash + taxable + pretax + roth;
    cumulativeCash += cash;
    cumulativeTaxable += taxable;
    const remainingCashBuffer = Math.max(0, startCash - cumulativeCash);
    const remainingTaxableBuffer = Math.max(0, startTaxable - cumulativeTaxable);
    const remainingLiquidBuffer = remainingCashBuffer + remainingTaxableBuffer;
    const iraRelianceRate = total > 0 ? pretax / total : 0;
    const priorYear = index > 0 ? allEntries[index - 1] : null;
    const priorWithdrawal = priorYear ? withdrawalByYear.get(priorYear.year) : null;
    const priorPretax = priorWithdrawal?.ira401k ?? 0;
    const priorTotal =
      (priorWithdrawal?.cash ?? 0) +
      (priorWithdrawal?.taxable ?? 0) +
      (priorWithdrawal?.ira401k ?? 0) +
      (priorWithdrawal?.roth ?? 0);
    const priorIraRelianceRate = priorTotal > 0 ? priorPretax / priorTotal : 0;
    const riskLabels: string[] = [];

    if (remainingCashBuffer <= Math.max(25_000, startCash * 0.2)) {
      riskLabels.push('Cash runs low');
    }
    if (
      startTaxable > 0 &&
      remainingTaxableBuffer <= startTaxable * 0.45 &&
      taxable >= (priorWithdrawal?.taxable ?? 0) * 0.9
    ) {
      riskLabels.push('Taxable depletion accelerates');
    }
    if (iraRelianceRate >= 0.45 && iraRelianceRate - priorIraRelianceRate >= 0.12) {
      riskLabels.push('IRA reliance spikes');
    } else if (iraRelianceRate >= 0.6) {
      riskLabels.push('IRA reliance spikes');
    }

    return {
      year: entry.year,
      cash,
      taxable,
      pretax,
      roth,
      total,
      remainingCashBuffer,
      remainingLiquidBuffer,
      iraRelianceRate,
      highRisk: riskLabels.length > 0,
      riskLabels,
    } satisfies BridgeYearData;
  });

  const highRiskYears = bridgeYears.filter((entry) => entry.highRisk);
  const totalBySource = {
    cash: bridgeYears.reduce((sum, entry) => sum + entry.cash, 0),
    taxable: bridgeYears.reduce((sum, entry) => sum + entry.taxable, 0),
    pretax: bridgeYears.reduce((sum, entry) => sum + entry.pretax, 0),
    roth: bridgeYears.reduce((sum, entry) => sum + entry.roth, 0),
  };
  const primaryFundingSources = Object.entries(totalBySource)
    .sort((left, right) => right[1] - left[1])
    .filter(([, value]) => value > 0)
    .slice(0, 2)
    .map(([key]) =>
      key === 'pretax' ? 'IRA' : key.charAt(0).toUpperCase() + key.slice(1),
    );
  const averageAnnualSpend = average(bridgeSeries.map((entry) => entry.medianSpending));
  const lowestBufferYear = [...bridgeYears].sort(
    (left, right) => left.remainingLiquidBuffer - right.remainingLiquidBuffer,
  )[0] ?? null;
  const firstCashLowYear =
    bridgeYears.find((entry) => entry.remainingCashBuffer <= Math.max(5_000, startCash * 0.08))
      ?.year ?? null;
  const peakTaxableYear =
    [...bridgeYears].sort((left, right) => right.taxable - left.taxable)[0] ?? null;
  const iraPrimaryYear = bridgeYears.find((entry) => entry.iraRelianceRate >= 0.5)?.year ?? null;
  const lowBufferYears = bridgeYears
    .filter((entry) => entry.remainingLiquidBuffer <= Math.max(40_000, (startCash + startTaxable) * 0.2))
    .map((entry) => entry.year);
  const heavySingleSourceYears = bridgeYears
    .filter((entry) => {
      const maxSource = Math.max(entry.cash, entry.taxable, entry.pretax, entry.roth);
      return entry.total > 0 && maxSource / entry.total >= 0.7;
    })
    .map((entry) => entry.year);
  const rapidDepletionYears = bridgeYears
    .filter((entry, index, allYears) => {
      if (index === 0) {
        return false;
      }
      const prior = allYears[index - 1];
      return (
        prior.remainingLiquidBuffer > 0 &&
        prior.remainingLiquidBuffer - entry.remainingLiquidBuffer >=
          Math.max(30_000, (startCash + startTaxable) * 0.18)
      );
    })
    .map((entry) => entry.year);
  const bridgeLooksSafe =
    highRiskYears.length === 0 &&
    (lowestBufferYear?.remainingLiquidBuffer ?? 0) > 50_000;
  const bridgeLooksManageable =
    highRiskYears.length <= 2 && (lowestBufferYear?.remainingLiquidBuffer ?? 0) > 0;

  const safeIndicator = bridgeLooksSafe
    ? {
        label: 'stable',
        tone: 'good' as const,
        detail:
          'Cash and taxable sources appear to cover the bridge years without heavy early IRA pressure.',
      }
    : bridgeLooksManageable
      ? {
          label: 'watch',
          tone: 'watch' as const,
          detail:
            'The bridge is workable, though a handful of years need closer attention as liquid reserves thin out.',
        }
      : {
          label: 'risky',
          tone: 'risk' as const,
          detail:
            'The plan reaches the bridge years, but it leans more heavily on IRA funding or thinner liquid reserves than we would like.',
        };

  const summary = lowestBufferYear
    ? `The bridge runs from ${retirementYear} to ${firstSocialSecurityYear - 1}. Liquid reserves are thinnest in ${lowestBufferYear.year}, when the remaining bridge buffer falls to ${formatCurrency(lowestBufferYear.remainingLiquidBuffer)}.`
    : `The bridge runs from ${retirementYear} to ${firstSocialSecurityYear - 1}.`;

  const riskCallouts = highRiskYears
    .slice()
    .sort((left, right) => {
      if (left.riskLabels.length !== right.riskLabels.length) {
        return right.riskLabels.length - left.riskLabels.length;
      }
      return left.remainingLiquidBuffer - right.remainingLiquidBuffer;
    })
    .slice(0, 3)
    .map((entry) => ({
      year: entry.year,
      title: entry.riskLabels[0] ?? 'Bridge pressure builds',
      detail: `We rely on ${entry.pretax > 0 ? 'more IRA funding' : 'less liquid funding'} here, and the remaining liquid buffer is ${formatCurrency(entry.remainingLiquidBuffer)}.`,
    }));

  const keyInsights = [
    firstCashLowYear
      ? `Cash gets thin around ${firstCashLowYear}, so that is where the bridge starts leaning more on other accounts.`
      : 'Cash does not fully run out during the visible bridge years.',
    peakTaxableYear && peakTaxableYear.taxable > 0
      ? `Taxable savings do the most work in ${peakTaxableYear.year}, when they cover about ${formatCurrency(peakTaxableYear.taxable)}.`
      : 'Taxable savings are not the main driver in this bridge window.',
    iraPrimaryYear
      ? `IRA funding becomes the main support around ${iraPrimaryYear}, which is where tax pressure starts to matter more.`
      : 'IRA funding never becomes the clear majority source before Social Security starts.',
    lowBufferYears.length
      ? `The bridge buffer looks thinnest in years like ${describeYearList(lowBufferYears)}, so those are the years we watch most closely.`
      : 'No low-buffer years stand out in the visible bridge window.',
    bridgeYears.every((entry) => entry.total > 0)
      ? 'There are no visible funding gaps in the bridge years shown here.'
      : 'One or more bridge years show little visible funding, so those years deserve a closer review.',
  ].slice(0, 5);

  const riskSignals = [
    heavySingleSourceYears.length
      ? `Heavy single-source reliance shows up in ${describeYearList(heavySingleSourceYears)}.`
      : 'Funding stays reasonably diversified across bridge years.',
    rapidDepletionYears.length
      ? `Liquid reserves fall quickly in ${describeYearList(rapidDepletionYears)}.`
      : 'Liquid reserves step down gradually rather than all at once.',
    lowBufferYears.length
      ? `Low buffer years appear in ${describeYearList(lowBufferYears)}.`
      : 'No low-buffer years stand out before Social Security begins.',
  ];

  return {
    retirementYear,
    firstSocialSecurityYear,
    bridgeYears,
    averageAnnualSpend,
    primaryFundingSources,
    safeIndicator,
    summary,
    keyInsights,
    riskSignals,
    riskCallouts,
  };
}

function buildBridgeStressSummary(input: {
  payload: PlanningStateExportCompact;
  activeOutcome: CompactOutcome;
  bridgeAnalysis: ReturnType<typeof buildBridgeAnalysis>;
}) {
  const riskModel = input.payload.runwayRiskModel;
  const stressedCurrentPlan =
    riskModel.comparisonMode === 'removed_runway_response'
      ? riskModel.counterfactual
      : riskModel.baseline;
  const successRateChange = stressedCurrentPlan.successRate - input.activeOutcome.successRate;
  const bridgeLength = Math.max(
    0,
    (input.bridgeAnalysis.firstSocialSecurityYear ?? input.bridgeAnalysis.retirementYear) -
      input.bridgeAnalysis.retirementYear,
  );
  const baselineLowBufferYear =
    input.bridgeAnalysis.bridgeYears.find(
      (entry) => entry.remainingLiquidBuffer <= Math.max(40_000, input.payload.assets.byBucket.cash * 0.2),
    )?.year ?? null;
  const bufferTimingLabel =
    successRateChange <= -0.08 || stressedCurrentPlan.earlyFailureProbability >= 0.2
      ? baselineLowBufferYear
        ? `Likely earlier than ${baselineLowBufferYear}`
        : `Likely earlier in the ${bridgeLength > 0 ? 'bridge' : 'early retirement'} years`
      : successRateChange <= -0.04 || stressedCurrentPlan.spendingCutRate >= 0.25
        ? baselineLowBufferYear
          ? `Possibly a little earlier than ${baselineLowBufferYear}`
          : 'Possibly a little earlier than the baseline path'
        : baselineLowBufferYear
          ? `Roughly similar to ${baselineLowBufferYear}`
          : 'Roughly similar to the baseline path';

  const detail =
    riskModel.provenBenefit
      ? 'The early-downturn stress test suggests that stronger runway reserves help absorb the first rough years after retiring.'
      : 'The early-downturn stress test suggests the bridge still works, but the first rough years would feel tighter.';

  return {
    stressedSuccessRate: stressedCurrentPlan.successRate,
    successRateChange,
    bufferTimingLabel,
    detail,
  } satisfies BridgeStressSummary;
}

function buildAnnualSpendScheduleForTradeBuilder(input: {
  data: SeedData;
  years: number[];
  retirementYear: number;
  travelPhaseYears: number;
  purchaseEvents: Array<{ year: number; amount: number }>;
  monthlySpendReduction?: number;
}) {
  const fixedAnnual =
    input.data.spending.essentialMonthly * 12 + input.data.spending.annualTaxesInsurance;
  const optionalAnnual = input.data.spending.optionalMonthly * 12;
  const travelAnnual = input.data.spending.travelEarlyRetirementAnnual;
  const annualReduction = Math.max(0, (input.monthlySpendReduction ?? 0) * 12);

  return Object.fromEntries(
    input.years.map((year) => {
      const yearsIntoRetirement = year - input.retirementYear;
      const inTravelPhase =
        yearsIntoRetirement >= 0 && yearsIntoRetirement < input.travelPhaseYears;
      const baseAnnualSpend =
        fixedAnnual + optionalAnnual + (inTravelPhase ? travelAnnual : 0);
      const adjustedSpend = Math.max(fixedAnnual, baseAnnualSpend - annualReduction);
      const purchaseOutflow = input.purchaseEvents
        .filter((event) => event.year === year)
        .reduce((sum, event) => sum + event.amount, 0);
      return [year, roundCurrency(adjustedSpend + purchaseOutflow)];
    }),
  );
}

function applyMoreAggressiveConversions(data: SeedData) {
  const currentPolicy = data.rules.rothConversionPolicy;
  data.rules.rothConversionPolicy = {
    enabled: currentPolicy?.enabled ?? true,
    strategy: currentPolicy?.strategy ?? 'aca_then_irmaa_headroom',
    minAnnualDollars: currentPolicy?.minAnnualDollars ?? 500,
    maxPretaxBalancePercent: Math.min(
      0.22,
      Math.max(0.08, (currentPolicy?.maxPretaxBalancePercent ?? 0.12) + 0.05),
    ),
    magiBufferDollars: Math.max(500, (currentPolicy?.magiBufferDollars ?? 2_000) - 1_000),
  };
}

function adjustHomeSaleTiming(data: SeedData, shiftYears: number) {
  const homeSale = data.income.windfalls.find((windfall) => windfall.taxTreatment === 'primary_home_sale');
  if (!homeSale) {
    return false;
  }
  homeSale.year += shiftYears;
  return true;
}

interface TradeBuilderScenarioSpec {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  years: number[];
  travelPhaseYears: number;
  purchaseYear: number;
  purchaseCost: number;
  monthlySpendReduction?: number;
  purchaseDelayYears?: number;
  purchasePhaseYears?: number;
  travelReductionAnnual?: number;
  homeSaleShiftYears?: number;
  conversionAdjustment?: 'none' | 'more_aggressive';
}

/**
 * Pure, main-thread data prep for a Trade Builder scenario. Applies the
 * lightweight SeedData mutations (travel trim, home-sale shift, conversion
 * policy bump) and builds the per-year spend schedule, but does NOT run the
 * simulation — it returns a SweepPointInput ready for the worker pool.
 */
function prepareTradeBuilderPoint(
  pointId: string,
  input: TradeBuilderScenarioSpec,
): SweepPointInput {
  const nextData = cloneSeedData(input.data);
  if ((input.travelReductionAnnual ?? 0) > 0) {
    nextData.spending.travelEarlyRetirementAnnual = Math.max(
      0,
      nextData.spending.travelEarlyRetirementAnnual - (input.travelReductionAnnual ?? 0),
    );
  }
  if ((input.homeSaleShiftYears ?? 0) !== 0) {
    adjustHomeSaleTiming(nextData, input.homeSaleShiftYears ?? 0);
  }
  if (input.conversionAdjustment === 'more_aggressive') {
    applyMoreAggressiveConversions(nextData);
  }

  const retirementYear =
    new Date(nextData.income.salaryEndDate).getUTCFullYear();
  const phasedYears = Math.max(1, input.purchasePhaseYears ?? 1);
  const phasedPurchaseAmount = phasedYears > 1 ? input.purchaseCost / phasedYears : input.purchaseCost;
  const purchaseEvents = Array.from({ length: phasedYears }, (_, index) => ({
    year: input.purchaseYear + (input.purchaseDelayYears ?? 0) + index,
    amount: roundCurrency(phasedPurchaseAmount),
  }));
  const annualSpendScheduleByYear = buildAnnualSpendScheduleForTradeBuilder({
    data: nextData,
    years: input.years,
    retirementYear,
    travelPhaseYears: input.travelPhaseYears,
    purchaseEvents,
    monthlySpendReduction: input.monthlySpendReduction,
  });

  return {
    pointId,
    data: nextData,
    assumptions: input.assumptions,
    selectedStressors: input.selectedStressors,
    selectedResponses: input.selectedResponses,
    strategyMode: 'planner_enhanced',
    annualSpendScheduleByYear,
  } satisfies SweepPointInput;
}

function pathToScenarioResult(path: PathResult): TradeBuilderScenarioResult {
  return {
    successRate: path.successRate,
    irmaaExposureRate: path.irmaaExposureRate,
    spendingCutRate: path.spendingCutRate,
    medianEndingWealth: path.medianEndingWealth,
  };
}

function chooseRecommendedTradeOption(
  options: TradeBuilderOption[],
  purchaseScenario: TradeBuilderScenarioResult,
) {
  return [...options].sort((left, right) => {
    const leftScore =
      left.successRateDelta * 100 +
      Math.max(0, -left.irmaaExposureDelta) * 30 +
      Math.max(0, -left.guardrailRelianceDelta) * 25 -
      left.disruptionScore -
      left.simplicityScore;
    const rightScore =
      right.successRateDelta * 100 +
      Math.max(0, -right.irmaaExposureDelta) * 30 +
      Math.max(0, -right.guardrailRelianceDelta) * 25 -
      right.disruptionScore -
      right.simplicityScore;
    if (Math.abs(rightScore - leftScore) > 0.001) {
      return rightScore - leftScore;
    }
    return right.successRate - left.successRate;
  })[0] ?? null;
}

function describeYearList(years: number[], maxYears = 3) {
  const visible = years.slice(0, maxYears);
  if (!visible.length) {
    return '';
  }
  return visible.join(', ');
}

function findGuardrailAdjustmentYears(input: {
  outcome: CompactOutcome;
  successDependsOnGuardrailCuts: boolean;
}) {
  if (!input.successDependsOnGuardrailCuts) {
    return [];
  }
  return input.outcome.yearlySeries
    .filter((entry, index, allYears) => {
      if (index === 0) {
        return false;
      }
      const priorYear = allYears[index - 1];
      return entry.medianSpending < priorYear.medianSpending - 1_000;
    })
    .map((entry) => entry.year);
}

function buildGuardrailCards(input: {
  payload: PlanningStateExportCompact;
  activeOutcome: CompactOutcome;
  activeSummary: PlanningStateExportCompact['activeSimulationSummary'];
  firstConversion: ReturnType<typeof getCompactFirstExecutedConversion>;
  nearThresholdYears: number[];
}) {
  const windfallYears = input.payload.income.windfalls
    .filter((entry) => entry.amount > 0)
    .map((entry) => entry.year);
  const withdrawalByYear = new Map(
    input.activeOutcome.simulationDiagnostics.withdrawalPath.map((entry) => [entry.year, entry]),
  );
  const incomeStackYears = input.activeOutcome.yearlySeries
    .filter((entry) => {
      const withdrawal = withdrawalByYear.get(entry.year);
      const hasMaterialWithdrawals =
        (withdrawal?.ira401k ?? 0) + (withdrawal?.taxable ?? 0) + (withdrawal?.roth ?? 0) > 15_000;
      const hasWindfall = windfallYears.includes(entry.year);
      const preRetirement = entry.year < input.payload.income.retirementYear;
      return hasMaterialWithdrawals && (preRetirement || hasWindfall);
    })
    .map((entry) => entry.year);

  return [
    {
      id: 'irmaa_threshold',
      icon: '🛟',
      title: 'Medicare premium line',
      explanation: `We keep income below ${formatApproxThousands(input.payload.constraints.irmaaThreshold)} to avoid higher Medicare premiums.`,
      watchLine: input.nearThresholdYears.length
        ? `What to watch: years like ${describeYearList(input.nearThresholdYears)} run close to that line, so we keep a little room.`
        : 'What to watch: the visible years leave healthy room below that line.',
    },
    {
      id: 'conversion_overshoot',
      icon: '↔️',
      title: 'Converting too much at once',
      explanation: 'We convert savings gradually to stay in lower tax ranges.',
      watchLine: input.firstConversion.year
        ? `What to watch: conversions begin around ${input.firstConversion.year} and are spread over multiple years instead of all at once.`
        : 'What to watch: there are no visible Roth conversion years in the current compact path.',
    },
    {
      id: 'income_stacking',
      icon: '⚖️',
      title: 'Too much income in one year',
      explanation: 'We avoid stacking withdrawals and income in the same year to prevent tax spikes.',
      watchLine: incomeStackYears.length
        ? `What to watch: years like ${describeYearList(incomeStackYears)} deserve a quick check because several cash sources may land together.`
        : 'What to watch: the current path keeps income sources fairly separated year to year.',
    },
    {
      id: 'spending_flexibility',
      icon: '🌤️',
      title: 'Being a little flexible on spending',
      explanation: 'The plan assumes we can adjust spending slightly if markets are weak.',
      watchLine: input.activeSummary.successDependsOnGuardrailCuts
        ? 'What to watch: this plan works best if we are comfortable trimming discretionary spending in weaker years.'
        : 'What to watch: flexibility is available, but this plan does not mainly rely on spending cuts.',
    },
    {
      id: 'inheritance_dependence',
      icon: '🤝',
      title: 'Counting on the inheritance',
      explanation: 'The plan is stronger if the inheritance arrives as expected.',
      watchLine: input.payload.inheritanceDependenceHeadline.inheritanceDependent
        ? 'What to watch: without that inheritance, the plan becomes materially tighter.'
        : 'What to watch: the plan does not appear to depend heavily on the inheritance arriving exactly as expected.',
    },
  ] satisfies GuardrailCardData[];
}

function buildRetirementWalkthrough(input: {
  payload: PlanningStateExportCompact;
  activeOutcome: CompactOutcome;
  activeSummary: PlanningStateExportCompact['activeSimulationSummary'];
  pretaxDepletionYear: number | null;
  nearThresholdYears: number[];
}) {
  const retirementYear = input.payload.income.retirementYear;
  const irmaaThreshold = input.payload.constraints.irmaaThreshold;
  const lowMagiThreshold = Math.min(80_000, irmaaThreshold * 0.4);
  const windfallYears = new Map(
    input.payload.income.windfalls
      .filter((entry) => entry.amount > 0)
      .map((entry) => [entry.year, entry.amount]),
  );
  const withdrawalByYear = new Map(
    input.activeOutcome.simulationDiagnostics.withdrawalPath.map((entry) => [entry.year, entry]),
  );
  const guardrailYears = new Set(
    findGuardrailAdjustmentYears({
      outcome: input.activeOutcome,
      successDependsOnGuardrailCuts: input.activeSummary.successDependsOnGuardrailCuts,
    }),
  );

  return input.activeOutcome.yearlySeries.map((entry, index, allYears) => {
    const year = entry.year;
    const priorYear = index > 0 ? allYears[index - 1] : null;
    const withdrawal = withdrawalByYear.get(year);
    const isPreRetirement = year < retirementYear;
    const isFirstRetirementYear = year === retirementYear;
    const hasConversion = entry.medianRothConversion > 0;
    const windfallAmount = windfallYears.get(year) ?? 0;
    const hasWindfall = windfallAmount > 0;
    const isLowMagiYear = entry.medianMagi > 0 && entry.medianMagi <= lowMagiThreshold;
    const isPretaxDepletionYear = input.pretaxDepletionYear === year;
    const rothWithdrawal = withdrawal?.roth ?? 0;
    const pretaxWithdrawal = withdrawal?.ira401k ?? 0;
    const isRothWithdrawalYear = rothWithdrawal > 5_000 && rothWithdrawal >= pretaxWithdrawal;
    const isGuardrailYear = guardrailYears.has(year);
    const nearThreshold = input.nearThresholdYears.includes(year);

    let headline = 'We keep following the plan with a steady mix of withdrawals and tax-aware moves.';
    let supporting: string | undefined;
    let notice: string | undefined;

    if (hasWindfall) {
      headline = 'We receive a large cash inflow, so we do not need to lean on portfolio withdrawals as much.';
      supporting = 'That gives us room to let invested assets keep compounding.';
      notice = 'You may notice a lighter withdrawal year.';
    } else if (isFirstRetirementYear) {
      headline = 'Your paycheck falls away, so we begin leaning more on savings and tax planning.';
      supporting = hasConversion
        ? 'We also start shifting some IRA money into Roth while income is lower.'
        : 'This is where the portfolio starts carrying more of the spending load.';
      notice = 'You may notice more flexibility once earned income drops.';
    } else if (isPreRetirement) {
      headline = 'You are still working, so we continue saving and building assets.';
      supporting = 'Paychecks and contributions are still doing a lot of the heavy lifting.';
      notice = 'You may notice steady account growth while work income is still present.';
    } else if (isPretaxDepletionYear) {
      headline = 'Your IRA is largely used by this point, which reduces future tax exposure.';
      supporting = 'That can make later withdrawals easier to manage.';
      notice = 'You may notice less future tax pressure coming from pretax accounts.';
    } else if (hasConversion) {
      headline = 'We convert some IRA money to Roth to reduce future taxes.';
      supporting = isLowMagiYear
        ? 'This is a lower-income year, so it is a good time to do some of that work.'
        : 'We do it gradually so we do not create a large tax jump in one year.';
      notice = nearThreshold
        ? 'You may notice us staying close to the Medicare premium line without going over it.'
        : 'You may notice a smoother tax path later on.';
    } else if (isRothWithdrawalYear) {
      headline = 'We rely more on Roth savings here, which helps keep this year tax-light.';
      supporting = 'That gives us flexibility without piling more income onto the tax return.';
      notice = 'You may notice steadier cash flow with less tax drag.';
    } else if (isLowMagiYear) {
      headline = 'We take advantage of lower taxes this year.';
      supporting = 'Years like this give us more planning flexibility than higher-income years do.';
      notice = 'You may notice this is one of the cleaner tax years in the plan.';
    } else if (isGuardrailYear) {
      headline = 'We may adjust spending slightly this year to stay on track.';
      supporting = 'The goal is to protect the long-term plan without making dramatic changes.';
      notice = 'You may notice a little more spending discipline if markets are weak.';
    } else if (priorYear && entry.medianAssets < priorYear.medianAssets * 0.95) {
      headline = 'We let the plan absorb a weaker market year without making abrupt moves.';
      supporting = 'The idea is to stay steady and avoid turning a rough patch into a permanent setback.';
      notice = 'You may notice patience matters more than activity here.';
    }

    return {
      year,
      headline,
      supporting,
      notice,
    } satisfies WalkthroughYearCard;
  });
}

function buildStorySections(input: {
  payload: PlanningStateExportCompact;
  activeOutcome: CompactOutcome;
  firstConversion: ReturnType<typeof getCompactFirstExecutedConversion>;
  pretaxDepletionYear: number | null;
  firstRmdYear: number | null;
  nearThresholdYears: number[];
  conversionTotal: number;
}): StorySection[] {
  const supportedSpend = formatCurrency(input.payload.planScorecard.canonical.supportedMonthlySpend);
  const sr = input.payload.planScorecard.canonical.successRate;
  const successHeadline =
    (input.payload.activeSimulationSummary as typeof input.payload.activeSimulationSummary & { successHeadline?: string }).successHeadline
    ?? (sr >= 0.9
      ? `The plan succeeds in ${Math.round(sr * 100)}% of simulated scenarios — a strong baseline.`
      : sr >= 0.75
      ? `The plan succeeds in ${Math.round(sr * 100)}% of simulated scenarios — on track with some margin to manage.`
      : sr >= 0.6
      ? `The plan succeeds in ${Math.round(sr * 100)}% of simulated scenarios — workable but worth watching.`
      : `The plan succeeds in ${Math.round(sr * 100)}% of simulated scenarios — below target, consider adjustments.`);
  const riskSummary = {
    medianFailureYear: input.activeOutcome.medianFailureYear ?? null,
    worstDecileEndingWealth: input.activeOutcome.riskMetrics?.worstDecileEndingWealth ?? 0,
  };
  const recommendationHeadline =
    input.payload.flightPath.recommendationAvailabilityHeadline.primaryReason;

  return [
    {
      id: 'early',
      eyebrow: 'Early Phase',
      title: 'Set the runway and shape taxes before pressure builds',
      body: input.firstConversion.year
        ? `The plan supports about ${supportedSpend} per month today. ${successHeadline} Roth conversions begin in ${input.firstConversion.year} for about ${formatCurrency(input.firstConversion.amount ?? 0)}, which starts moving pretax dollars before later RMD and IRMAA pressure shows up.`
        : `The plan supports about ${supportedSpend} per month today. ${successHeadline} No early Roth conversion is modeled, so the planner is leaning on existing account mix and withdrawal ordering rather than front-loading tax moves.`,
    },
    {
      id: 'middle',
      eyebrow: 'Middle Phase',
      title: 'Manage MAGI and work down pretax risk deliberately',
      body: `${formatCurrency(input.conversionTotal)} of visible Roth conversions are modeled on the active path. ${input.nearThresholdYears.length ? `Visible MAGI pressure clusters around ${input.nearThresholdYears.join(', ')}, so the planner stays close to the IRMAA line without crossing it.` : 'Visible MAGI stays comfortably away from the IRMAA line in the compact view.'} ${input.pretaxDepletionYear ? `Pretax balances are largely worked down by ${input.pretaxDepletionYear}.` : 'Pretax balances remain available through the visible horizon.'}`,
    },
    {
      id: 'late',
      eyebrow: 'Late Phase',
      title: 'Reduce forced withdrawals and keep downside readable',
      body: `${input.firstRmdYear ? `RMD pressure first becomes visible around ${input.firstRmdYear}.` : 'RMD pressure stays muted in the visible years.'} ${riskSummary.medianFailureYear ? `When runs fail, the median failure year is ${riskSummary.medianFailureYear}.` : 'Median failure year is not observed in the compact risk summary.'} Worst-decile ending wealth is ${formatCurrency(riskSummary.worstDecileEndingWealth)}. ${recommendationHeadline}`,
    },
  ];
}

function Plan20Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[32px] border border-white/70 bg-white/80 p-6 shadow-lg shadow-amber-950/5 backdrop-blur">
      <div className="mb-5">
        <h2 className="font-serif text-3xl tracking-tight text-stone-900">{title}</h2>
        {subtitle ? (
          <p className="mt-2 max-w-[72ch] text-sm leading-6 text-stone-600">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Plan20SummaryCard({
  label,
  value,
  valueLabel,
  secondaryValue,
  secondaryLabel,
  detail,
  accent = 'blue',
}: {
  label: string;
  value: string;
  valueLabel?: string;
  secondaryValue?: string;
  secondaryLabel?: string;
  detail: string;
  accent?: 'blue' | 'teal' | 'amber' | 'stone';
}) {
  const accentClasses = {
    blue: 'text-blue-700',
    teal: 'text-teal-700',
    amber: 'text-amber-700',
    stone: 'text-stone-700',
  };

  return (
    <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
      <p className="text-xs uppercase tracking-[0.18em] text-stone-500">{label}</p>
      <p className={`mt-4 text-3xl font-semibold tracking-tight ${accentClasses[accent]}`}>
        {value}
        {valueLabel ? (
          <span className="ml-2 align-middle text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            {valueLabel}
          </span>
        ) : null}
      </p>
      {secondaryValue ? (
        <p className="mt-1 text-sm text-stone-500">
          <span className="font-medium text-stone-700">{secondaryValue}</span>
          {secondaryLabel ? (
            <span className="ml-2 text-xs uppercase tracking-[0.14em] text-stone-500">
              {secondaryLabel}
            </span>
          ) : null}
        </p>
      ) : null}
      <p className="mt-3 text-sm leading-6 text-stone-600">{detail}</p>
    </article>
  );
}

function Plan20ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <article className="rounded-[30px] border border-stone-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.97),rgba(248,250,252,0.98))] p-5 shadow-sm">
      <div className="mb-4">
        <p className="text-lg font-semibold text-stone-900">{title}</p>
        <p className="mt-1 text-sm leading-6 text-stone-600">{subtitle}</p>
      </div>
      <div className="h-72">{children}</div>
    </article>
  );
}

function Plan20NarrativeCard({ section }: { section: StorySection }) {
  return (
    <article className="rounded-[28px] border border-stone-200/80 bg-stone-50/85 p-5">
      <p className="text-xs uppercase tracking-[0.2em] text-blue-700">{section.eyebrow}</p>
      <h3 className="mt-3 text-2xl font-semibold leading-tight text-stone-900">{section.title}</h3>
      <p className="mt-3 text-sm leading-7 text-stone-600">{section.body}</p>
    </article>
  );
}

function GuardrailsSection({ cards }: { cards: GuardrailCardData[] }) {
  return (
    <section>
      <div className="mb-4">
        <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Guardrails</p>
        <h3 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
          Things We&apos;re Careful To Avoid
        </h3>
        <p className="mt-2 max-w-[72ch] text-sm leading-6 text-stone-600">
          These are the practical boundaries we keep in mind so the plan stays steady and
          understandable.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <article
            key={card.id}
            className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 text-xl" aria-hidden="true">
                {card.icon}
              </span>
              <div>
                <h4 className="text-xl font-semibold text-stone-900">{card.title}</h4>
                <p className="mt-3 text-sm leading-7 text-stone-600">{card.explanation}</p>
                {card.watchLine ? (
                  <p className="mt-3 rounded-[18px] bg-stone-50 px-3 py-2 text-sm leading-6 text-stone-600">
                    {card.watchLine}
                  </p>
                ) : null}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function RetirementWalkthrough({ items }: { items: WalkthroughYearCard[] }) {
  return (
    <section>
      <div className="mb-4">
        <p className="text-xs uppercase tracking-[0.18em] text-stone-500">
          Retirement Walkthrough
        </p>
        <h3 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
          What to Expect Each Year
        </h3>
        <p className="mt-2 max-w-[72ch] text-sm leading-6 text-stone-600">
          This is the plain-English version of the path we are following, year by year.
        </p>
      </div>
      <div className="relative pl-6">
        <div className="absolute left-[11px] top-0 h-full w-px bg-stone-200" />
        <div className="space-y-4">
          {items.map((item) => (
            <div key={item.year} className="relative">
              <div className="absolute -left-[2px] top-7 h-3 w-3 rounded-full bg-blue-600 shadow-sm" />
              <article className="rounded-[28px] border border-stone-200/80 bg-white/92 p-5 shadow-sm">
                <p className="text-xs uppercase tracking-[0.18em] text-blue-700">{item.year}</p>
                <h4 className="mt-3 text-2xl font-semibold leading-tight text-stone-900">
                  {item.headline}
                </h4>
                {item.supporting ? (
                  <p className="mt-3 text-sm leading-7 text-stone-600">{item.supporting}</p>
                ) : null}
                {item.notice ? (
                  <p className="mt-3 rounded-[18px] bg-stone-50 px-3 py-2 text-sm leading-6 text-stone-600">
                    What you&apos;ll notice: {item.notice}
                  </p>
                ) : null}
              </article>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function EarlyRetirementBridgeAnalysis(input: {
  retirementYear: number;
  firstSocialSecurityYear: number | null;
  bridgeYears: BridgeYearData[];
  averageAnnualSpend: number;
  primaryFundingSources: string[];
  safeIndicator: {
    label: string;
    tone: 'good' | 'watch' | 'risk';
    detail: string;
  };
  summary: string;
  keyInsights: string[];
  riskSignals: string[];
  riskCallouts: BridgeRiskCallout[];
  stressSummary: BridgeStressSummary | null;
}) {
  const [showStressTest, setShowStressTest] = useState(false);
  const indicatorTone =
    input.safeIndicator.tone === 'good'
      ? 'bg-emerald-50 text-emerald-800'
      : input.safeIndicator.tone === 'watch'
        ? 'bg-amber-50 text-amber-800'
        : 'bg-rose-50 text-rose-800';
  const bridgeRangeTitle =
    input.firstSocialSecurityYear !== null && input.firstSocialSecurityYear > input.retirementYear
      ? `Early Retirement Bridge (${input.retirementYear}–${input.firstSocialSecurityYear - 1})`
      : 'Early Retirement Bridge';
  const legendItems = [
    { label: 'Cash', color: 'bg-teal-700' },
    { label: 'Taxable', color: 'bg-sky-600' },
    { label: 'IRA', color: 'bg-blue-600' },
    { label: 'Roth', color: 'bg-violet-500' },
    { label: 'Remaining buffer', color: 'bg-amber-500' },
  ];

  if (!input.bridgeYears.length) {
    return (
      <section>
        <div className="mb-4">
          <p className="text-xs uppercase tracking-[0.18em] text-stone-500">
            Early Retirement Bridge Analysis
          </p>
          <h3 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            {bridgeRangeTitle}
          </h3>
        </div>
        <div className="rounded-[28px] border border-stone-200/80 bg-white/90 p-6 shadow-sm">
          <p className="text-lg font-semibold text-stone-900">
            There is little or no bridge window to fund in this plan.
          </p>
          <p className="mt-3 text-sm leading-6 text-stone-600">
            Social Security appears to begin immediately or close enough that a separate bridge
            analysis is not needed.
          </p>
        </div>
      </section>
    );
  }

  return (
      <section>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-stone-500">
            Early Retirement Bridge Analysis
          </p>
          <h3 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            {bridgeRangeTitle}
          </h3>
          <p className="mt-2 max-w-[72ch] text-sm leading-6 text-stone-600">{input.summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {input.stressSummary ? (
            <label className="flex items-center gap-2 rounded-full bg-stone-100 px-4 py-2 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={showStressTest}
                onChange={(event) => setShowStressTest(event.target.checked)}
              />
              Show early-downturn stress view
            </label>
          ) : null}
          <div className={`rounded-[22px] px-4 py-3 text-sm font-semibold uppercase tracking-[0.08em] ${indicatorTone}`}>
            Status: {input.safeIndicator.label}
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <article className="rounded-[26px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
          <p className="text-sm font-medium text-stone-500">Average annual spend</p>
          <p className="mt-3 text-3xl font-semibold text-stone-900">
            {formatCurrency(input.averageAnnualSpend)}
          </p>
          <p className="mt-3 text-sm leading-6 text-stone-600">
            Average spending across the bridge years shown here.
          </p>
        </article>
        <article className="rounded-[26px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
          <p className="text-sm font-medium text-stone-500">Primary funding sources</p>
          <p className="mt-3 text-3xl font-semibold text-stone-900">
            {input.primaryFundingSources.length ? input.primaryFundingSources.join(' + ') : 'None'}
          </p>
          <p className="mt-3 text-sm leading-6 text-stone-600">
            These are the sources doing most of the work before Social Security starts.
          </p>
        </article>
        <article className="rounded-[26px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
          <p className="text-sm font-medium text-stone-500">Can we fund this safely?</p>
          <p className="mt-3 text-3xl font-semibold text-stone-900 capitalize">
            {input.safeIndicator.label}
          </p>
          <p className="mt-3 text-sm leading-6 text-stone-600">{input.safeIndicator.detail}</p>
        </article>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <article className="rounded-[30px] border border-stone-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.97),rgba(248,250,252,0.98))] p-5 shadow-sm">
          <div className="mb-4">
            <p className="text-lg font-semibold text-stone-900">Bridge funding by year</p>
            <p className="mt-1 text-sm leading-6 text-stone-600">
              Bars show where spending comes from, and the line shows how much liquid bridge buffer
              appears to remain.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {legendItems.map((item) => (
                <span
                  key={item.label}
                  className="inline-flex items-center gap-2 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-700"
                >
                  <span className={`h-2.5 w-2.5 rounded-full ${item.color}`} />
                  {item.label}
                </span>
              ))}
            </div>
          </div>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={input.bridgeYears}>
                <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
                <XAxis dataKey="year" tickLine={false} axisLine={false} />
                <YAxis
                  yAxisId="left"
                  tickFormatter={(value) => `${Math.round(value / 1000)}k`}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tickFormatter={(value) => `${Math.round(value / 1000)}k`}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Bar yAxisId="left" dataKey="cash" stackId="funding" fill="#0f766e" radius={[6, 6, 0, 0]} />
                <Bar yAxisId="left" dataKey="taxable" stackId="funding" fill="#0891b2" radius={[6, 6, 0, 0]} />
                <Bar yAxisId="left" dataKey="pretax" stackId="funding" fill="#2563eb" radius={[6, 6, 0, 0]} />
                <Bar yAxisId="left" dataKey="roth" stackId="funding" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="remainingLiquidBuffer"
                  stroke="#f59e0b"
                  strokeWidth={3}
                  dot={false}
                />
                <Scatter yAxisId="right" data={input.bridgeYears.filter((entry) => entry.highRisk)} dataKey="remainingLiquidBuffer" fill="#dc2626" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </article>

        <div className="space-y-4">
          <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
            <p className="text-sm font-medium text-stone-500">Key insights</p>
            <div className="mt-4 space-y-3">
              {input.keyInsights.map((insight) => (
                <p
                  key={insight}
                  className="rounded-[18px] bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-700"
                >
                  {insight}
                </p>
              ))}
            </div>
          </article>
          <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
            <p className="text-sm font-medium text-stone-500">Risk signals</p>
            <div className="mt-4 space-y-3">
              {input.riskSignals.map((signal) => (
                <p
                  key={signal}
                  className="rounded-[18px] bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-700"
                >
                  {signal}
                </p>
              ))}
            </div>
          </article>
          {input.riskCallouts.length ? (
            <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
              <p className="text-sm font-medium text-stone-500">Highest-risk years</p>
              <div className="mt-4 space-y-3">
                {input.riskCallouts.map((callout) => (
                  <div key={callout.year} className="rounded-[20px] bg-stone-50 px-4 py-3">
                    <p className="text-sm font-semibold text-stone-900">
                      {callout.year} · {callout.title}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-stone-600">{callout.detail}</p>
                  </div>
                ))}
              </div>
            </article>
          ) : null}
          {showStressTest && input.stressSummary ? (
            <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
              <p className="text-sm font-medium text-stone-500">Stress test: early downturn</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-[18px] bg-stone-50 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.14em] text-stone-500">
                    Success rate change
                  </p>
                  <p className="mt-2 text-2xl font-semibold text-stone-900">
                    {formatPercentPointDelta(input.stressSummary.successRateChange)}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    Baseline {formatPercent(input.stressSummary.stressedSuccessRate - input.stressSummary.successRateChange)} vs stressed {formatPercent(input.stressSummary.stressedSuccessRate)}.
                  </p>
                </div>
                <div className="rounded-[18px] bg-stone-50 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.14em] text-stone-500">
                    Buffer pressure timing
                  </p>
                  <p className="mt-2 text-2xl font-semibold text-stone-900">
                    {input.stressSummary.bufferTimingLabel}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    {input.stressSummary.detail}
                  </p>
                </div>
              </div>
            </article>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function TradeBuilderSection(input: {
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  activeOutcome: CompactOutcome;
  retirementYear: number;
  travelPhaseYears: number;
}) {
  const currentYear = input.activeOutcome.yearlySeries[0]?.year ?? input.retirementYear;
  const [purchaseName, setPurchaseName] = useState('Vehicle');
  const [purchaseCost, setPurchaseCost] = useState(55_000);
  const [purchaseYear, setPurchaseYear] = useState(input.retirementYear + 1);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [purchaseScenario, setPurchaseScenario] = useState<TradeBuilderScenarioResult | null>(null);
  const [options, setOptions] = useState<TradeBuilderOption[]>([]);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [fromCache, setFromCache] = useState(false);

  const years = useMemo(
    () => input.activeOutcome.yearlySeries.map((entry) => entry.year),
    [input.activeOutcome.yearlySeries],
  );
  const baseScenario = useMemo(
    () => ({
      successRate: input.activeOutcome.successRate,
      irmaaExposureRate: input.activeOutcome.irmaaExposureRate,
      spendingCutRate: input.activeOutcome.spendingCutRate,
      medianEndingWealth: input.activeOutcome.medianEndingWealth,
    }),
    [input.activeOutcome],
  );
  const recommendedOption = useMemo(
    () => (purchaseScenario ? chooseRecommendedTradeOption(options, purchaseScenario) : null),
    [options, purchaseScenario],
  );

  const fingerprint = useMemo(
    () =>
      `${purchaseYear}|${purchaseCost}|${input.travelPhaseYears}|${buildEvaluationFingerprint({
        data: input.data,
        assumptions: input.assumptions,
        selectedStressors: input.selectedStressors,
        selectedResponses: input.selectedResponses,
      })}`,
    [
      input.assumptions,
      input.data,
      input.selectedResponses,
      input.selectedStressors,
      input.travelPhaseYears,
      purchaseCost,
      purchaseYear,
    ],
  );

  // Try cache whenever fingerprint changes
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await loadTradeBuilderFromCache<{
        purchaseScenario: TradeBuilderScenarioResult;
        options: TradeBuilderOption[];
      }>(fingerprint);
      if (cancelled) return;
      if (cached) {
        setPurchaseScenario(cached.purchaseScenario);
        setOptions(cached.options);
        setLoadState('ready');
        setFromCache(true);
        setProgress(1);
      } else {
        setFromCache(false);
        if (loadState !== 'loading') {
          setLoadState('idle');
          setPurchaseScenario(null);
          setOptions([]);
          setProgress(0);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  const inFlightBatchRef = useRef<SweepPoolHandle | null>(null);
  useEffect(() => {
    return () => {
      inFlightBatchRef.current?.cancel();
    };
  }, []);

  const runTradeBuilder = () => {
    // Cancel any previous in-flight batch before kicking a new one off.
    inFlightBatchRef.current?.cancel();

    setLoadState('loading');
    setLoadError(null);
    setProgress(0);
    setProgressLabel('Running scenarios in parallel…');
    setFromCache(false);

    // Metadata for each option — we build the full list up front so we can
    // look up a result by pointId when the worker pool streams it back.
    interface OptionMeta {
      id: string;
      title: string;
      description: string;
      requiredChange: string;
      disruptionScore: number;
      simplicityScore: number;
      group: 'spending' | 'delay' | 'travel' | 'timing' | 'conversion';
    }
    const commonSpec = {
      data: input.data,
      assumptions: input.assumptions,
      selectedStressors: input.selectedStressors,
      selectedResponses: input.selectedResponses,
      years,
      travelPhaseYears: input.travelPhaseYears,
      purchaseYear,
      purchaseCost,
    } as const;

    const points: SweepPointInput[] = [];
    const meta = new Map<string, OptionMeta | null>(); // null = baseline purchase-only

    // Baseline purchase-only scenario (no option meta).
    const baselineId = 'purchase-baseline';
    points.push(prepareTradeBuilderPoint(baselineId, { ...commonSpec }));
    meta.set(baselineId, null);

    const addOption = (
      id: string,
      m: Omit<OptionMeta, 'id'>,
      spec: Partial<TradeBuilderScenarioSpec>,
    ) => {
      points.push(prepareTradeBuilderPoint(id, { ...commonSpec, ...spec }));
      meta.set(id, { id, ...m });
    };

    for (const reduction of [150, 300, 500, 650]) {
      addOption(
        `reduce-spend-${reduction}`,
        {
          title: 'Reduce spending',
          description: 'Trim monthly spending a bit so the purchase lands more gently on the plan.',
          requiredChange: `Reduce spending by ${formatCurrency(reduction)}/month`,
          disruptionScore: reduction / 80,
          simplicityScore: 1,
          group: 'spending',
        },
        { monthlySpendReduction: reduction },
      );
    }

    for (const delayYears of [1, 2, 3]) {
      addOption(
        `delay-${delayYears}`,
        {
          title: 'Delay purchase',
          description: 'Give the portfolio more time before the cash leaves the plan.',
          requiredChange: `Delay the purchase by ${delayYears} year${delayYears === 1 ? '' : 's'}`,
          disruptionScore: delayYears * 2,
          simplicityScore: 1,
          group: 'delay',
        },
        { purchaseDelayYears: delayYears },
      );
    }

    if (input.data.spending.travelEarlyRetirementAnnual > 0) {
      for (const share of [0.25, 0.5]) {
        const annualReduction = roundCurrency(
          input.data.spending.travelEarlyRetirementAnnual * share,
        );
        addOption(
          `travel-${share}`,
          {
            title: 'Trim travel',
            description: 'Use travel as a temporary buffer instead of cutting core lifestyle first.',
            requiredChange: `Reduce travel by ${formatCurrency(annualReduction)}/year for the early retirement years`,
            disruptionScore: share * 6,
            simplicityScore: 2,
            group: 'travel',
          },
          { travelReductionAnnual: annualReduction },
        );
      }
    }

    const homeSaleWindfallExists = input.data.income.windfalls.some(
      (windfall) => windfall.taxTreatment === 'primary_home_sale',
    );
    if (homeSaleWindfallExists) {
      for (const shiftYears of [-1, 1]) {
        addOption(
          `home-sale-shift-${shiftYears}`,
          {
            title: 'Adjust home sale timing',
            description: 'Move the existing home sale timing a bit to better line up with the purchase.',
            requiredChange: `${shiftYears < 0 ? 'Move' : 'Delay'} the home sale by ${Math.abs(shiftYears)} year`,
            disruptionScore: 4 + Math.abs(shiftYears),
            simplicityScore: 2,
            group: 'timing',
          },
          { homeSaleShiftYears: shiftYears },
        );
      }
    } else {
      addOption(
        'phase-purchase',
        {
          title: 'Phase the purchase',
          description: 'Split the cost across two years instead of taking the full hit all at once.',
          requiredChange: `Phase ${formatCurrency(purchaseCost)} over 2 years`,
          disruptionScore: 3,
          simplicityScore: 2,
          group: 'timing',
        },
        { purchasePhaseYears: 2 },
      );
    }

    addOption(
      'conversion-aggressive',
      {
        title: 'Lean harder on Roth conversions',
        description: 'Use tax-shaping instead of bigger lifestyle changes if that trade feels better.',
        requiredChange: 'Use a more aggressive Roth conversion strategy',
        disruptionScore: 5,
        simplicityScore: 2,
        group: 'conversion',
      },
      { conversionAdjustment: 'more_aggressive' },
    );

    const totalPoints = points.length;
    const resultsByPointId = new Map<string, TradeBuilderScenarioResult>();
    const batchId = `trade-builder-${Date.now()}`;

    inFlightBatchRef.current = runSweepBatch(batchId, points, (event) => {
      if (event.type === 'point') {
        resultsByPointId.set(event.pointId, pathToScenarioResult(event.path));
        setProgress(resultsByPointId.size / totalPoints);
        setProgressLabel(
          `Tested ${resultsByPointId.size} of ${totalPoints} scenario${totalPoints === 1 ? '' : 's'}…`,
        );
        return;
      }

      if (event.type === 'error') {
        inFlightBatchRef.current = null;
        setLoadState('error');
        setLoadError(event.error || 'Trade Builder failed to run.');
        return;
      }

      if (event.type === 'cancelled') {
        inFlightBatchRef.current = null;
        return;
      }

      if (event.type !== 'done') return;
      inFlightBatchRef.current = null;

      const purchase = resultsByPointId.get(baselineId);
      if (!purchase) {
        setLoadState('error');
        setLoadError('Baseline scenario missing from worker results.');
        return;
      }

      const buildOption = (optMeta: OptionMeta, result: TradeBuilderScenarioResult) => ({
        id: optMeta.id,
        title: optMeta.title,
        description: optMeta.description,
        requiredChange: optMeta.requiredChange,
        successRate: result.successRate,
        irmaaExposureRate: result.irmaaExposureRate,
        spendingCutRate: result.spendingCutRate,
        medianEndingWealth: result.medianEndingWealth,
        disruptionScore: optMeta.disruptionScore,
        simplicityScore: optMeta.simplicityScore,
        successRateDelta: result.successRate - purchase.successRate,
        irmaaExposureDelta: result.irmaaExposureRate - purchase.irmaaExposureRate,
        guardrailRelianceDelta: result.spendingCutRate - purchase.spendingCutRate,
      } satisfies TradeBuilderOption);

      // Bucket by group, pick the best candidate in each group (same logic as
      // before: max successRateDelta, tiebreak on disruption).
      const pickBestInGroup = (group: OptionMeta['group']): TradeBuilderOption | null => {
        const candidates: TradeBuilderOption[] = [];
        for (const [pid, m] of meta) {
          if (!m || m.group !== group) continue;
          const r = resultsByPointId.get(pid);
          if (!r) continue;
          candidates.push(buildOption(m, r));
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => {
          if (Math.abs(b.successRateDelta - a.successRateDelta) > 0.001) {
            return b.successRateDelta - a.successRateDelta;
          }
          return a.disruptionScore - b.disruptionScore;
        });
        return candidates[0];
      };

      const nextOptions = (
        ['spending', 'delay', 'travel', 'timing', 'conversion'] as const
      )
        .map((g) => pickBestInGroup(g))
        .filter((o): o is TradeBuilderOption => Boolean(o))
        .sort((left, right) => {
          const leftScore =
            left.successRateDelta * 100 +
            Math.max(0, -left.irmaaExposureDelta) * 30 +
            Math.max(0, -left.guardrailRelianceDelta) * 25 -
            left.disruptionScore -
            left.simplicityScore;
          const rightScore =
            right.successRateDelta * 100 +
            Math.max(0, -right.irmaaExposureDelta) * 30 +
            Math.max(0, -right.guardrailRelianceDelta) * 25 -
            right.disruptionScore -
            right.simplicityScore;
          return rightScore - leftScore;
        })
        .slice(0, 4);

      setPurchaseScenario(purchase);
      setOptions(nextOptions);
      setProgress(1);
      setProgressLabel('Finalizing…');
      setLoadState('ready');
      void saveTradeBuilderToCache(fingerprint, {
        purchaseScenario: purchase,
        options: nextOptions,
      });
    });
  };

  const purchaseYearOptions = years.filter((year) => year >= currentYear);

  return (
    <section>
      <div className="mb-4">
        <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Trade Builder</p>
        <h3 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
          Model a large purchase and see the tradeoffs
        </h3>
        <p className="mt-2 max-w-[72ch] text-sm leading-6 text-stone-600">
          This does not change the base plan. Retirement timing stays fixed, and this tool only tests retired-household levers for absorbing a large purchase.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
        <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
          <p className="text-sm font-medium text-stone-500">Purchase card</p>
          <div className="mt-4 space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-stone-700">Purchase name</span>
              <input
                type="text"
                value={purchaseName}
                onChange={(event) => setPurchaseName(event.target.value)}
                className="mt-2 w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-stone-900 outline-none ring-0 focus:border-blue-400"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-stone-700">Cost</span>
              <input
                type="number"
                min={0}
                step={1000}
                value={purchaseCost}
                onChange={(event) => setPurchaseCost(Number(event.target.value) || 0)}
                className="mt-2 w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-stone-900 outline-none ring-0 focus:border-blue-400"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-stone-700">Year</span>
              <select
                value={purchaseYear}
                onChange={(event) => setPurchaseYear(Number(event.target.value))}
                className="mt-2 w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-stone-900 outline-none ring-0 focus:border-blue-400"
              >
                {purchaseYearOptions.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => runTradeBuilder()}
              disabled={loadState === 'loading'}
              className="w-full rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-stone-400"
            >
              {loadState === 'loading'
                ? 'Running trade study…'
                : loadState === 'ready'
                  ? 'Recalculate purchase'
                  : 'Model purchase'}
            </button>
            {loadState === 'loading' ? (
              <div>
                <div className="h-2 overflow-hidden rounded-full bg-stone-200">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all"
                    style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-stone-600">{progressLabel || 'Running scenarios…'}</p>
              </div>
            ) : null}
            <p className="text-xs leading-6 text-stone-500">
              Example: {purchaseName || 'Purchase'} · {formatCurrency(purchaseCost)} in {purchaseYear}
              {fromCache && loadState === 'ready' ? (
                <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                  from cache
                </span>
              ) : null}
            </p>
          </div>
        </article>

        <div className="space-y-4">
          {loadState === 'idle' ? (
            <article className="rounded-[28px] border border-dashed border-stone-300 bg-stone-50/80 p-6">
              <p className="text-lg font-semibold text-stone-900">No trade study yet</p>
              <p className="mt-2 text-sm leading-6 text-stone-600">
                Enter a purchase and run the scenario to see the impact summary and recovery options.
              </p>
            </article>
          ) : null}
          {loadState === 'error' ? (
            <article className="rounded-[28px] border border-red-200 bg-red-50 p-6 text-sm text-red-800 shadow-sm">
              Trade Builder failed: {loadError}
            </article>
          ) : null}
          {purchaseScenario ? (
            <>
              <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
                <p className="text-sm font-medium text-stone-500">Impact summary</p>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-[20px] bg-stone-50 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Success rate</p>
                    <p className="mt-2 text-2xl font-semibold text-stone-900">
                      {formatPercentPointDelta(purchaseScenario.successRate - baseScenario.successRate)}
                    </p>
                    <p className="mt-2 text-sm text-stone-600">
                      New success {formatPercent(purchaseScenario.successRate)}
                    </p>
                  </div>
                  <div className="rounded-[20px] bg-stone-50 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.14em] text-stone-500">IRMAA exposure</p>
                    <p className="mt-2 text-2xl font-semibold text-stone-900">
                      {formatPercentPointDelta(purchaseScenario.irmaaExposureRate - baseScenario.irmaaExposureRate)}
                    </p>
                    <p className="mt-2 text-sm text-stone-600">
                      New exposure {formatPercent(purchaseScenario.irmaaExposureRate)}
                    </p>
                  </div>
                  <div className="rounded-[20px] bg-stone-50 px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.14em] text-stone-500">Guardrail reliance</p>
                    <p className="mt-2 text-2xl font-semibold text-stone-900">
                      {formatPercentPointDelta(purchaseScenario.spendingCutRate - baseScenario.spendingCutRate)}
                    </p>
                    <p className="mt-2 text-sm text-stone-600">
                      New cut rate {formatPercent(purchaseScenario.spendingCutRate)}
                    </p>
                  </div>
                </div>
              </article>

              <article className="rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-stone-500">Tradeoff options</p>
                    <p className="mt-2 text-sm leading-6 text-stone-600">
                      Baseline here means the purchase as entered. These options keep the base plan untouched and only test realistic ways to absorb the {purchaseName.toLowerCase()} purchase.
                    </p>
                  </div>
                  {recommendedOption ? (
                    <span className="rounded-full bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800">
                      Recommended Option: {recommendedOption.title}
                    </span>
                  ) : null}
                </div>
                <div className="mt-4 space-y-3">
                  {options.map((option) => {
                    const isRecommended = recommendedOption?.id === option.id;
                    return (
                      <article
                        key={option.id}
                        className={`rounded-[24px] border p-4 ${
                          isRecommended
                            ? 'border-emerald-300 bg-emerald-50/70'
                            : 'border-stone-200 bg-stone-50/80'
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-stone-900">{option.title}</p>
                            <h4 className="mt-1 text-xl font-semibold text-stone-900">
                              {option.requiredChange}
                            </h4>
                            <p className="mt-2 text-sm leading-6 text-stone-600">
                              {option.description}
                            </p>
                          </div>
                          <div className="rounded-[18px] bg-white px-4 py-3 text-sm text-stone-700 shadow-sm">
                            Success <span className="font-semibold">{formatPercent(option.successRate)}</span>
                          </div>
                        </div>
                        <div className="mt-4 grid gap-3 md:grid-cols-3">
                          <div className="rounded-[18px] bg-white px-4 py-3 text-sm text-stone-700">
                            Delta vs baseline <span className="font-semibold">{formatPercentPointDelta(option.successRateDelta)}</span>
                          </div>
                          <div className="rounded-[18px] bg-white px-4 py-3 text-sm text-stone-700">
                            IRMAA exposure <span className="font-semibold">{formatPercent(option.irmaaExposureRate)}</span>
                          </div>
                          <div className="rounded-[18px] bg-white px-4 py-3 text-sm text-stone-700">
                            Guardrail reliance <span className="font-semibold">{formatPercent(option.spendingCutRate)}</span>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </article>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Plan20RiskCard({
  title,
  headline,
  detail,
}: {
  title: string;
  headline: string;
  detail: string;
}) {
  return (
    <article className="rounded-[26px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
      <p className="text-sm font-medium text-stone-500">{title}</p>
      <h3 className="mt-3 text-2xl font-semibold text-stone-900">{headline}</h3>
      <p className="mt-3 text-sm leading-6 text-stone-600">{detail}</p>
    </article>
  );
}

function Plan20DeltaCard({
  title,
  delta,
  detail,
  kind,
}: {
  title: string;
  delta: string;
  detail: string;
  kind: 'positive' | 'negative' | 'neutral';
}) {
  const tone =
    kind === 'positive'
      ? 'text-emerald-700'
      : kind === 'negative'
        ? 'text-red-700'
        : 'text-stone-700';

  return (
    <article className="rounded-[26px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
      <p className="text-sm font-medium text-stone-500">{title}</p>
      <p className={`mt-3 text-3xl font-semibold ${tone}`}>{delta}</p>
      <p className="mt-3 text-sm leading-6 text-stone-600">{detail}</p>
    </article>
  );
}

function ThisYearsFocusCard({ focus, year }: { focus: ThisYearsFocus; year: number }) {
  return (
    <section className="rounded-[32px] border border-blue-200/70 bg-gradient-to-br from-blue-50 via-white to-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-700">
            {year} focus
          </p>
          <h3 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
            {focus.phaseLabel}
          </h3>
        </div>
        <span className="rounded-full bg-blue-700/90 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-white">
          {focus.phase.replace('-', ' ')}
        </span>
      </div>
      <p className="mt-3 max-w-[80ch] text-base leading-7 text-stone-700">{focus.headline}</p>
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
            Do now
          </p>
          <ul className="mt-2 space-y-2 text-sm leading-6 text-stone-800">
            {focus.actions.map((action, index) => (
              <li key={index} className="flex gap-2">
                <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600" />
                <span>{action}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
            Why it matters
          </p>
          <p className="mt-2 text-sm leading-6 text-stone-700">{focus.why}</p>
        </div>
      </div>
    </section>
  );
}

function Plan20LoadingState() {
  return (
    <Plan20Section
      title="Plan 2.0"
      subtitle="Building a compact, decision-oriented view from the current planner export."
    >
      <div className="animate-pulse space-y-6">
        <div className="grid gap-4 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-40 rounded-[28px] bg-stone-200/80" />
          ))}
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-96 rounded-[30px] bg-stone-200/80" />
          ))}
        </div>
      </div>
    </Plan20Section>
  );
}

function Plan20EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <Plan20Section title="Plan 2.0" subtitle="A cleaner planner surface built from the compact export.">
      <div className="rounded-[28px] border border-dashed border-stone-300 bg-stone-50/80 p-10 text-center">
        <h3 className="text-2xl font-semibold text-stone-900">{title}</h3>
        <p className="mx-auto mt-3 max-w-[56ch] text-sm leading-6 text-stone-600">{detail}</p>
      </div>
    </Plan20Section>
  );
}

export function Plan20Screen() {
  const data = useAppStore((state) => state.data);
  const assumptions = useAppStore((state) => state.draftAssumptions);
  const selectedStressors = useAppStore((state) => state.draftSelectedStressors);
  const selectedResponses = useAppStore((state) => state.draftSelectedResponses);
  const { payload, loadState, loadError } = usePlanningExportPayload('compact');

  const compactPayload = payload as PlanningStateExportCompact | null;
  const activeOutcome = compactPayload?.activeSimulationOutcome as CompactOutcome | undefined;
  const rawOutcome = (compactPayload?.simulationOutcomes?.rawSimulation ?? compactPayload?.debug?.rawSimulation) as CompactOutcome | undefined;

  const activeSummaryBase = compactPayload?.activeSimulationSummary;
  const activeSummary = activeSummaryBase
    ? {
        ...activeSummaryBase,
        successHeadline: (activeSummaryBase as typeof activeSummaryBase & { successHeadline?: string }).successHeadline
          ?? (() => {
              const sr = compactPayload?.planScorecard.canonical.successRate ?? 0;
              if (sr >= 0.9) return `The plan succeeds in ${Math.round(sr * 100)}% of simulated scenarios — a strong baseline.`;
              if (sr >= 0.75) return `The plan succeeds in ${Math.round(sr * 100)}% of simulated scenarios — on track with some margin to manage.`;
              if (sr >= 0.6) return `The plan succeeds in ${Math.round(sr * 100)}% of simulated scenarios — workable but worth watching.`;
              return `The plan succeeds in ${Math.round(sr * 100)}% of simulated scenarios — below target, consider adjustments.`;
            })(),
        successDependsOnGuardrailCuts: (activeSummaryBase as typeof activeSummaryBase & { successDependsOnGuardrailCuts?: boolean }).successDependsOnGuardrailCuts
          ?? (activeOutcome?.spendingCutRate ?? 0) > 0.15,
        spendingCutRate: (activeSummaryBase as typeof activeSummaryBase & { spendingCutRate?: number }).spendingCutRate
          ?? (activeOutcome?.spendingCutRate ?? 0),
      }
    : undefined;
  const irmaaThreshold = compactPayload?.constraints.irmaaThreshold ?? 0;
  const supportedMonthlySpend = compactPayload?.planScorecard.canonical.supportedMonthlySpend ?? 0;

  const firstConversion = useMemo(
    () => (activeOutcome ? getCompactFirstExecutedConversion(activeOutcome) : null),
    [activeOutcome],
  );
  const conversionTotal = useMemo(
    () => (activeOutcome ? getCompactTotalConversions(activeOutcome) : 0),
    [activeOutcome],
  );
  const pretaxDepletionYear = useMemo(
    () => (activeOutcome ? getCompactPretaxDepletionYear(activeOutcome) : null),
    [activeOutcome],
  );
  const rawPretaxDepletionYear = useMemo(
    () => (rawOutcome ? getCompactPretaxDepletionYear(rawOutcome) : null),
    [rawOutcome],
  );
  const firstRmdYear = useMemo(
    () => (activeOutcome ? getFirstRmdYear(activeOutcome) : null),
    [activeOutcome],
  );
  const assetChartData = useMemo(
    () => (activeOutcome ? buildAssetChartData(activeOutcome) : []),
    [activeOutcome],
  );
  const magiChartData = useMemo(
    () => (activeOutcome ? buildMagiChartData(activeOutcome, irmaaThreshold) : []),
    [activeOutcome, irmaaThreshold],
  );
  const conversionChartData = useMemo(
    () => (activeOutcome ? buildConversionChartData(activeOutcome, irmaaThreshold) : []),
    [activeOutcome, irmaaThreshold],
  );
  const withdrawalMixData = useMemo(
    () => (activeOutcome ? buildWithdrawalMixChartData(activeOutcome) : []),
    [activeOutcome],
  );

  const nearThresholdYears = useMemo(
    () =>
      magiChartData
        .filter((entry) => entry.nearThresholdMagi !== null)
        .map((entry) => entry.year),
    [magiChartData],
  );
  const storySections = useMemo(
    () =>
      compactPayload && activeOutcome && firstConversion
        ? buildStorySections({
            payload: compactPayload,
            activeOutcome,
            firstConversion,
            pretaxDepletionYear,
            firstRmdYear,
            nearThresholdYears,
            conversionTotal,
          })
        : [],
    [
      compactPayload,
      activeOutcome,
      firstConversion,
      pretaxDepletionYear,
      firstRmdYear,
      nearThresholdYears,
      conversionTotal,
    ],
  );
  const guardrailCards = useMemo(
    () =>
      compactPayload && activeOutcome && activeSummary && firstConversion
        ? buildGuardrailCards({
            payload: compactPayload,
            activeOutcome,
            activeSummary,
            firstConversion,
            nearThresholdYears,
          })
        : [],
    [
      compactPayload,
      activeOutcome,
      activeSummary,
      firstConversion,
      nearThresholdYears,
    ],
  );
  const walkthroughItems = useMemo(
    () =>
      compactPayload && activeOutcome && activeSummary
        ? buildRetirementWalkthrough({
            payload: compactPayload,
            activeOutcome,
            activeSummary,
            pretaxDepletionYear,
            nearThresholdYears,
          })
        : [],
    [
      compactPayload,
      activeOutcome,
      activeSummary,
      pretaxDepletionYear,
      nearThresholdYears,
    ],
  );
  const bridgeAnalysis = useMemo(
    () =>
      compactPayload && activeOutcome
        ? buildBridgeAnalysis({
            payload: compactPayload,
            activeOutcome,
          })
        : null,
    [compactPayload, activeOutcome],
  );
  const bridgeStressSummary = useMemo(
    () =>
      compactPayload && activeOutcome && bridgeAnalysis
        ? buildBridgeStressSummary({
            payload: compactPayload,
            activeOutcome,
            bridgeAnalysis,
          })
        : null,
    [compactPayload, activeOutcome, bridgeAnalysis],
  );

  if (loadState === 'loading' || loadState === 'idle') {
    return <Plan20LoadingState />;
  }

  if (loadState === 'error') {
    return (
      <Plan20EmptyState
        title="Plan 2.0 could not load"
        detail={loadError ?? 'The compact export failed to generate for this draft.'}
      />
    );
  }

  if (!compactPayload || !activeOutcome || !rawOutcome || !activeSummary || !firstConversion) {
    return (
      <Plan20EmptyState
        title="Plan 2.0 is waiting for planner data"
        detail="Run the planner/export flow once so the compact export can populate the new presentation layer."
      />
    );
  }

  const successDelta = activeOutcome.successRate - rawOutcome.successRate;
  const wealthDelta = activeOutcome.medianEndingWealth - rawOutcome.medianEndingWealth;
  const irmaaDelta = activeOutcome.irmaaExposureRate - rawOutcome.irmaaExposureRate;
  const conversionDelta = conversionTotal - getCompactTotalConversions(rawOutcome);
  const successTone = getDeltaTone(successDelta, 'percent');
  const wealthTone = getDeltaTone(wealthDelta, 'currency');
  const irmaaTone = getDeltaTone(-irmaaDelta, 'percent');
  const rawComparisonLabel =
    activeSummary.activeSimulationProfile === 'plannerEnhancedSimulation'
      ? 'Planner-enhanced active plan versus raw baseline.'
      : 'Current active plan versus raw baseline. Switch planner mode on to make this a pure planner-versus-raw comparison.';

  const inheritanceRate =
    compactPayload.inheritanceDependenceHeadline.dependenceEvidence.reconciledRate ??
    activeOutcome.inheritanceDependenceRate;
  const homeSaleRate = compactPayload.planScorecard.canonical.homeSaleDependenceRate;
  const runwayDeltas = compactPayload.runwayRiskModel.deltas;
  const rationaleBullets = (activeOutcome.simulationDiagnostics as typeof activeOutcome.simulationDiagnostics & { rationaleSummary?: string[] }).rationaleSummary?.slice(0, 5) ?? [];

  return (
    <Plan20Section
      title="Plan 2.0"
      subtitle="A calmer, chart-first planner surface built from the compact export. It keeps the active plan front and center, while raw stays as the comparison branch."
    >
      <div className="space-y-8">
        <ThisYearsFocusCard
          focus={buildThisYearsFocus(data)}
          year={new Date().getUTCFullYear()}
        />
        <TimeAsSafetyPanel
          data={data}
          assumptions={assumptions}
          selectedStressors={selectedStressors}
          selectedResponses={selectedResponses}
          strategyMode={
            compactPayload?.activeSimulationProfile === 'rawSimulation'
              ? 'raw_simulation'
              : 'planner_enhanced'
          }
        />
        <section>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-blue-700">Active Plan</p>
              <h3 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
                {activeSummary.activeSimulationProfile === 'plannerEnhancedSimulation'
                  ? 'Planner-enhanced path'
                  : 'Raw simulation path'}
              </h3>
              <p className="mt-2 max-w-[72ch] text-sm leading-6 text-stone-600">
                {activeSummary.successHeadline}
              </p>
            </div>
            <div className="rounded-full bg-stone-100 px-4 py-2 text-sm text-stone-700">
              Planner conversions{' '}
              <span className="font-semibold">
                {activeSummary.plannerConversionsExecuted ? 'executed' : 'not executed'}
              </span>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <Plan20SummaryCard
              label="Success rate"
              value={formatPercent(activeOutcome.successRate)}
              valueLabel="Flex"
              secondaryValue={formatPercent(rawOutcome.successRate)}
              secondaryLabel="Hands off"
              detail={
                activeSummary.successDependsOnGuardrailCuts
                  ? `Success is paired with a ${formatPercent(activeSummary.spendingCutRate)} guardrail-cut rate.`
                  : 'Success does not primarily rely on guardrail cuts.'
              }
              accent="blue"
            />
            <Plan20SummaryCard
              label="Supported monthly spend"
              value={formatCurrency(supportedMonthlySpend)}
              secondaryValue={`${formatCurrency(supportedMonthlySpend * 12)}/yr`}
              detail={`Target spend now: ${formatCurrency(compactPayload.flightPath.executiveSummary.planHealth.targetMonthlySpend)}.`}
              accent="teal"
            />
            <Plan20SummaryCard
              label="IRMAA exposure"
              value={`${activeOutcome.irmaaExposure} · ${formatPercent(activeOutcome.irmaaExposureRate)}`}
              detail={
                nearThresholdYears.length
                  ? `Visible pressure years: ${nearThresholdYears.join(', ')}.`
                  : 'Visible MAGI stays away from the IRMAA line.'
              }
              accent="amber"
            />
            <Plan20SummaryCard
              label="First Roth conversion"
              value={
                firstConversion.year && firstConversion.amount
                  ? `${firstConversion.year} · ${formatCurrency(firstConversion.amount)}`
                  : 'No conversion'
              }
              detail={
                firstConversion.reason
                  ? `${formatConstraintLabel(firstConversion.reason)}${firstConversion.magiBefore !== null && firstConversion.magiAfter !== null ? ` · MAGI ${formatCurrency(firstConversion.magiBefore)} to ${formatCurrency(firstConversion.magiAfter)}` : ''}`
                  : 'No conversion years are visible in the compact trace.'
              }
              accent="blue"
            />
            <Plan20SummaryCard
              label="Success interpretation"
              value={activeSummary.successDependsOnGuardrailCuts ? 'Guardrails matter' : 'Guardrails secondary'}
              detail={activeSummary.successHeadline}
              accent="stone"
            />
          </div>
        </section>

        <PortfolioHistoryCard />

        <SpendVsSafetyScreen />

        <section>
          <div className="mb-4">
            <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Main Charts</p>
            <h3 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
              What happens over time
            </h3>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Plan20ChartCard
              title="Assets over time"
              subtitle="Median total assets on the active path, kept simple so the slope is easy to read."
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={assetChartData}>
                  <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
                  <XAxis dataKey="year" tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(value) => `${Math.round(value / 1000)}k`} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                  <Area type="monotone" dataKey="assets" stroke="#2563eb" fill="#bfdbfe" strokeWidth={3} />
                </AreaChart>
              </ResponsiveContainer>
            </Plan20ChartCard>

            <Plan20ChartCard
              title="MAGI versus IRMAA line"
              subtitle="The threshold band is shaded so near-threshold years stand out immediately."
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={magiChartData}>
                  <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
                  <XAxis dataKey="year" tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(value) => `${Math.round(value / 1000)}k`} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                  <ReferenceArea
                    y1={Math.max(0, irmaaThreshold - 15_000)}
                    y2={irmaaThreshold}
                    fill="#fef3c7"
                    fillOpacity={0.55}
                  />
                  <Line type="monotone" dataKey="magi" stroke="#0f766e" strokeWidth={3} dot={false} />
                  <Line type="monotone" dataKey="threshold" stroke="#f59e0b" strokeWidth={2} strokeDasharray="6 4" dot={false} />
                  {nearThresholdYears.length ? (
                    <Scatter data={magiChartData} dataKey="nearThresholdMagi" fill="#dc2626" />
                  ) : null}
                </LineChart>
              </ResponsiveContainer>
            </Plan20ChartCard>

            <Plan20ChartCard
              title="Roth conversions over time"
              subtitle="Only the visible conversion years and surrounding context are kept in compact mode."
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={conversionChartData}>
                  <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
                  <XAxis dataKey="year" tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(value) => `${Math.round(value / 1000)}k`} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                  <Bar dataKey="amount" fill="#2563eb" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Plan20ChartCard>

            <Plan20ChartCard
              title="Withdrawal mix over time"
              subtitle="Cash, taxable, pretax, and Roth withdrawals stay separated so later pressure shifts are easy to spot."
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={withdrawalMixData}>
                  <CartesianGrid stroke="#d6d3d1" strokeDasharray="3 3" />
                  <XAxis dataKey="year" tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(value) => `${Math.round(value / 1000)}k`} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                  <Area type="monotone" dataKey="cash" stackId="1" stroke="#0f766e" fill="#99f6e4" />
                  <Area type="monotone" dataKey="taxable" stackId="1" stroke="#0891b2" fill="#bae6fd" />
                  <Area type="monotone" dataKey="pretax" stackId="1" stroke="#2563eb" fill="#bfdbfe" />
                  <Area type="monotone" dataKey="roth" stackId="1" stroke="#7c3aed" fill="#ddd6fe" />
                </AreaChart>
              </ResponsiveContainer>
            </Plan20ChartCard>
          </div>
        </section>

        <GuardrailsSection cards={guardrailCards} />

        {bridgeAnalysis ? (
          <EarlyRetirementBridgeAnalysis
            retirementYear={bridgeAnalysis.retirementYear}
            firstSocialSecurityYear={bridgeAnalysis.firstSocialSecurityYear}
            bridgeYears={bridgeAnalysis.bridgeYears}
            averageAnnualSpend={bridgeAnalysis.averageAnnualSpend}
            primaryFundingSources={bridgeAnalysis.primaryFundingSources}
            safeIndicator={bridgeAnalysis.safeIndicator}
            summary={bridgeAnalysis.summary}
            keyInsights={bridgeAnalysis.keyInsights}
            riskSignals={bridgeAnalysis.riskSignals}
            riskCallouts={bridgeAnalysis.riskCallouts}
            stressSummary={bridgeStressSummary}
          />
        ) : null}

        <TradeBuilderSection
          data={data}
          assumptions={assumptions}
          selectedStressors={selectedStressors}
          selectedResponses={selectedResponses}
          activeOutcome={activeOutcome}
          retirementYear={compactPayload.income.retirementYear}
          travelPhaseYears={compactPayload.assumptions.horizon.travelPhaseYears}
        />

        <section>
          <div className="mb-4">
            <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Plan Story</p>
            <h3 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
              Plain-English read of the active path
            </h3>
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            {storySections.map((section) => (
              <Plan20NarrativeCard key={section.id} section={section} />
            ))}
          </div>
          <div className="mt-4 rounded-[28px] border border-stone-200/80 bg-white/90 p-5 shadow-sm">
            <p className="text-xs uppercase tracking-[0.18em] text-blue-700">Why the planner chose this path</p>
            <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="space-y-3">
                {rationaleBullets.length ? (
                  rationaleBullets.map((bullet) => (
                    <div key={bullet} className="rounded-[20px] bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-700">
                      {bullet}
                    </div>
                  ))
                ) : (
                  <div className="rounded-[20px] bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-700">
                    Compact rationale bullets are not available for this run yet.
                  </div>
                )}
              </div>
              <div className="rounded-[24px] bg-blue-50 px-4 py-4 text-sm leading-6 text-stone-700">
                <p>
                  <span className="font-semibold text-stone-900">Recommendation read:</span>{' '}
                  {compactPayload.flightPath.recommendationAvailabilityHeadline.primaryReason}
                </p>
                <p className="mt-3">
                  <span className="font-semibold text-stone-900">Can act now:</span>{' '}
                  {compactPayload.flightPath.recommendationAvailabilityHeadline.canActNow ? 'Yes' : 'No'}
                </p>
                <p className="mt-3">
                  <span className="font-semibold text-stone-900">Where things stand:</span>{' '}
                  {compactPayload.flightPath.executiveSummary.narrative.whereThingsStand}
                </p>
                <p className="mt-3">
                  <span className="font-semibold text-stone-900">What matters now:</span>{' '}
                  {compactPayload.flightPath.executiveSummary.narrative.whatMattersNow}
                </p>
              </div>
            </div>
          </div>
        </section>

        <RetirementWalkthrough items={walkthroughItems} />

        <section>
          <div className="mb-4">
            <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Risk / Fragility</p>
            <h3 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
              Where the plan is sturdy and where it leans on help
            </h3>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {(() => {
              const withIr =
                compactPayload.inheritanceDependenceHeadline.upsideCaseIncludingInheritance
                  ?.successRate ?? activeOutcome.successRate;
              const withoutIr =
                compactPayload.inheritanceDependenceHeadline.baseCaseExcludingInheritance
                  ?.successRate ?? null;
              const drop = withoutIr !== null ? Math.max(0, withIr - withoutIr) : null;
              const fragile = drop !== null && drop >= 0.1;
              const headline = fragile
                ? `${Math.round(drop * 100)} pt drop if removed`
                : compactPayload.inheritanceDependenceHeadline.inheritanceDependent
                  ? `${formatPercent(inheritanceRate)} dependent`
                  : 'Not primarily inheritance-dependent';
              const detail = fragile
                ? `With inheritance ${formatPercent(withIr)} → without ${formatPercent(withoutIr ?? 0)}. Stress-test via the "Delayed inheritance" scenario before treating this plan as resilient.`
                : compactPayload.inheritanceDependenceHeadline.inheritanceDependent
                  ? `Robustness score ${compactPayload.inheritanceDependenceHeadline.inheritanceRobustnessScore.toFixed(2)} with fragility penalty ${compactPayload.inheritanceDependenceHeadline.fragilityPenalty.toFixed(2)}.`
                  : `Reconciled dependence rate ${formatPercent(inheritanceRate)} with no primary inheritance dependence flag.`;
              return (
                <Plan20RiskCard title="Inheritance fragility" headline={headline} detail={detail} />
              );
            })()}
            <Plan20RiskCard
              title="Home sale dependence"
              headline={formatPercent(homeSaleRate)}
              detail="This is the reconciled home-sale dependence rate surfaced by the compact scorecard."
            />
            <Plan20RiskCard
              title="Runway risk benefit"
              headline={compactPayload.runwayRiskModel.provenBenefit ? 'Runway helps' : 'Benefit unproven'}
              detail={`Runway score ${compactPayload.runwayRiskModel.runwayRiskReductionScore.toFixed(2)}. Early-failure delta ${formatPercent(runwayDeltas.earlyFailureProbability)} and spending-cut delta ${formatPercent(runwayDeltas.spendingCutRate)} in the modeled counterfactual.`}
            />
            <Plan20RiskCard
              title="Guardrail reliance"
              headline={
                activeSummary.successDependsOnGuardrailCuts
                  ? 'Success depends on cuts'
                  : 'Cuts are secondary'
              }
              detail={`Spending cut rate ${formatPercent(activeSummary.spendingCutRate)}. ${activeSummary.successHeadline}`}
            />
          </div>
        </section>

        <section>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">Comparison</p>
              <h3 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">
                Planner versus raw baseline
              </h3>
            </div>
            <p className="max-w-[48ch] text-sm leading-6 text-stone-600">{rawComparisonLabel}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <Plan20DeltaCard
              title="Success rate"
              delta={formatPercentPointDelta(successDelta)}
              detail={`Planner ${formatPercent(activeOutcome.successRate)} vs raw ${formatPercent(rawOutcome.successRate)}. ${successTone.detail}`}
              kind={successDelta > 0.005 ? 'positive' : successDelta < -0.005 ? 'negative' : 'neutral'}
            />
            <Plan20DeltaCard
              title="Median wealth"
              delta={formatSignedCurrencyDelta(wealthDelta)}
              detail={`Planner ${formatCurrency(activeOutcome.medianEndingWealth)} vs raw ${formatCurrency(rawOutcome.medianEndingWealth)}. ${wealthTone.detail}`}
              kind={wealthDelta > 0 ? 'positive' : wealthDelta < 0 ? 'negative' : 'neutral'}
            />
            <Plan20DeltaCard
              title="IRMAA exposure"
              delta={formatPercentPointDelta(irmaaDelta)}
              detail={`Planner ${formatPercent(activeOutcome.irmaaExposureRate)} vs raw ${formatPercent(rawOutcome.irmaaExposureRate)}.`}
              kind={irmaaDelta < -0.005 ? 'positive' : irmaaDelta > 0.005 ? 'negative' : 'neutral'}
            />
            <Plan20DeltaCard
              title="Pretax depletion timing"
              delta={
                pretaxDepletionYear
                  ? `${pretaxDepletionYear}`
                  : 'Not depleted'
              }
              detail={`Raw baseline: ${rawPretaxDepletionYear ? rawPretaxDepletionYear : 'Not depleted'}. Lower-year depletion usually means pretax pressure was moved earlier.`}
              kind="neutral"
            />
            <Plan20DeltaCard
              title="Roth conversion usage"
              delta={formatSignedCurrencyDelta(conversionDelta)}
              detail={`Planner ${formatCurrency(conversionTotal)} vs raw ${formatCurrency(getCompactTotalConversions(rawOutcome))}.`}
              kind={conversionDelta > 0 ? 'positive' : conversionDelta < 0 ? 'negative' : 'neutral'}
            />
          </div>
        </section>
      </div>
    </Plan20Section>
  );
}
