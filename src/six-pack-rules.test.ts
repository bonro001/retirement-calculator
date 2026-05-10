import { describe, expect, it } from 'vitest';
import { buildSixPackSnapshot } from './six-pack-rules';
import type { SixPackSpendingContext } from './six-pack-spending';
import type { SeedData } from './types';
import { initialSeedData } from './data';
import {
  buildHomeAssistantSixPackPanelPayload,
  buildHomeAssistantSixPackPayload,
} from './home-assistant-six-pack-contract';
import type { PortfolioWeatherSnapshot } from './portfolio-weather';

const asOfIso = '2026-05-10T12:00:00.000Z';

function cloneSeedData(): SeedData {
  return structuredClone(initialSeedData) as SeedData;
}

function spendingContext(
  projected: number,
  budget = 7_500,
): SixPackSpendingContext {
  return {
    budgetPlan: {
      month: '2026-05',
      monthlyBudget: budget,
      basis: 'retirement_seed',
      categories: [],
    },
    summary: {
      month: '2026-05',
      asOfIso,
      dayOfMonth: 10,
      daysInMonth: 31,
      percentMonthElapsed: 0.3226,
      monthlyBudget: budget,
      expectedByToday: 0,
      grossSpend: 0,
      refunds: 0,
      ignoredSpend: 0,
      netSpend: 0,
      projectedMonthEnd: projected,
      budgetRemaining: 0,
      paceDelta: 0,
      status: 'on_track',
      categories: [],
      transactionCount: 12,
      includedTransactionCount: 12,
      ignoredTransactionCount: 0,
      modelCompleteness: {
        indicator: 'faithful',
        missingInputs: [],
        inferredAssumptions: [],
        explicitInputCount: 1,
        reconstructedInputCount: 0,
      },
      intermediateCalculations: {
        elapsedShare: 0.3226,
        categoryBudgetTotal: budget,
        categoryBudgetGap: 0,
        grossIncludedDebits: 0,
        includedCredits: 0,
        ignoredDebits: 0,
      },
    },
    monthlyOperatingBudget: budget,
    monthlyOperatingSpent: 2_200,
    monthlyOperatingProjected: projected,
    annualEscrowPlannedBudget: 30_000,
    annualEscrowActualSpend: 29_000,
    annualEscrowAdaptiveBudget: 30_000,
    transactionCount: 12,
    ledgerStatus: 'loaded',
  };
}

describe('buildSixPackSnapshot', () => {
  it('keeps lifestyle pace green inside the monthly operating lane', () => {
    const snapshot = buildSixPackSnapshot({
      data: cloneSeedData(),
      spending: spendingContext(7_600),
      portfolioWeather: null,
      evaluation: null,
      evaluationCapturedAtIso: null,
      asOfIso,
    });

    const lifestyle = snapshot.instruments.find((item) => item.id === 'lifestyle_pace');
    expect(lifestyle?.status).toBe('green');
    expect(lifestyle?.frontMetric).toContain('/ $7.5k mo');
  });

  it('turns lifestyle amber and red at explicit thresholds', () => {
    const amber = buildSixPackSnapshot({
      data: cloneSeedData(),
      spending: spendingContext(8_000),
      portfolioWeather: null,
      evaluation: null,
      evaluationCapturedAtIso: null,
      asOfIso,
    }).instruments.find((item) => item.id === 'lifestyle_pace');
    const red = buildSixPackSnapshot({
      data: cloneSeedData(),
      spending: spendingContext(8_400),
      portfolioWeather: null,
      evaluation: null,
      evaluationCapturedAtIso: null,
      asOfIso,
    }).instruments.find((item) => item.id === 'lifestyle_pace');

    expect(amber?.status).toBe('amber');
    expect(red?.status).toBe('red');
  });

  it('keeps absorbed annual escrow swings green in watch items', () => {
    const snapshot = buildSixPackSnapshot({
      data: cloneSeedData(),
      spending: {
        ...spendingContext(7_000),
        annualEscrowPlannedBudget: 30_000,
        annualEscrowActualSpend: 38_000,
        annualEscrowAdaptiveBudget: 38_000,
      },
      portfolioWeather: null,
      evaluation: null,
      evaluationCapturedAtIso: null,
      asOfIso,
    });

    const watch = snapshot.instruments.find((item) => item.id === 'watch_items');
    expect(watch?.status).toBe('green');
    expect(watch?.headline).toBe('QUIET');
    expect(watch?.detail).toContain('monthly operating lane is already reduced');
  });

  it('serializes the Home Assistant aggregate without raw diagnostics', () => {
    const snapshot = buildSixPackSnapshot({
      data: cloneSeedData(),
      spending: spendingContext(7_000),
      portfolioWeather: null,
      evaluation: null,
      evaluationCapturedAtIso: null,
      asOfIso,
    });

    const payload = buildHomeAssistantSixPackPayload(snapshot);

    expect(payload.state).toBe(snapshot.overallStatus);
    expect(payload.attributes.pucks.lifestyle_pace).toBe('green');
    expect(JSON.stringify(payload)).not.toContain('diagnostics');
  });

  it('serializes a Home Assistant panel payload for one-call puck rendering', () => {
    const snapshot = buildSixPackSnapshot({
      data: cloneSeedData(),
      spending: spendingContext(7_000),
      portfolioWeather: null,
      evaluation: null,
      evaluationCapturedAtIso: null,
      asOfIso,
    });

    const payload = buildHomeAssistantSixPackPanelPayload(snapshot);

    expect(payload.state).toBe(snapshot.overallStatus);
    expect(payload.attributes.pucks).toHaveLength(6);
    expect(payload.attributes.pucks[0]).toMatchObject({
      id: 'lifestyle_pace',
      order: 1,
      color: 'green',
      front_metric: '$2.2k / $7.5k mo',
    });
    expect(JSON.stringify(payload)).not.toContain('diagnostics');
  });

  it('turns portfolio weather green when quoted value is steady or higher', () => {
    const portfolioWeather: PortfolioWeatherSnapshot = {
      available: true,
      asOfIso,
      importAsOfDate: '2026-04-30',
      quoteAsOfIso: asOfIso,
      importValue: 100_000,
      estimatedValue: 101_500,
      changeDollars: 1_500,
      changePercent: 1.5,
      quoteCoveragePercent: 95,
      quotedImportValue: 100_000,
      quotedEstimatedValue: 101_500,
      cashValueHeldAtImport: 0,
      missingQuoteValueHeldAtImport: 0,
      missingShareValueHeldAtImport: 0,
      heldAtImportValue: 0,
      missingQuoteSymbols: [],
      missingShareSymbols: [],
      holdings: [],
    };

    const snapshot = buildSixPackSnapshot({
      data: cloneSeedData(),
      spending: spendingContext(7_000),
      portfolioWeather,
      evaluation: null,
      evaluationCapturedAtIso: null,
      asOfIso,
    });

    const weather = snapshot.instruments.find((item) => item.id === 'portfolio_weather');
    expect(weather?.status).toBe('green');
    expect(weather?.headline).toBe('TAILWIND');
  });
});
