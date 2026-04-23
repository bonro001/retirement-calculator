import { describe, it, expect } from 'vitest';
import {
  buildAnnualTaxActual,
  buildBalanceSnapshotActual,
  buildMonthlySpendingActual,
  createInMemoryActualsLogStore,
  logActual,
  type ActualsRecord,
} from './actuals-log';
import {
  createInMemoryPredictionLogStore,
  logPrediction,
  type PredictionRecord,
} from './prediction-log';
import {
  reconcileActualsVsPredictions,
  summarizeReconciliation,
} from './reconciliation';

function makePrediction(overrides: Partial<PredictionRecord> = {}): PredictionRecord {
  return {
    timestamp: '2026-01-01T00:00:00Z',
    planFingerprint: 'fp-a',
    engineVersion: 'v1',
    inputs: { seedData: {} as never, assumptions: {} as never },
    outputs: {
      successRate: 0.9,
      medianEndingWealth: 2_000_000,
      tenthPercentileEndingWealth: 700_000,
      lifetimeFederalTaxEstimate: 150_000,
      peakMedianAssets: 2_500_000,
      peakMedianAssetsYear: 2055,
    },
    yearlyTrajectory: [
      {
        year: 2026,
        medianAssets: 920_000,
        medianSpending: 120_000,
        medianFederalTax: 22_000,
        medianIncome: 140_000,
      },
      {
        year: 2027,
        medianAssets: 950_000,
        medianSpending: 130_000,
        medianFederalTax: 24_000,
        medianIncome: 150_000,
      },
    ],
    ...overrides,
  };
}

describe('reconciliation', () => {
  it('matches actuals to the most recent prior prediction with same fingerprint', () => {
    const predictionStore = createInMemoryPredictionLogStore();
    logPrediction(predictionStore, makePrediction());

    const actualsStore = createInMemoryActualsLogStore();
    const balanceActual: ActualsRecord = {
      capturedAt: '2026-06-01T00:00:00Z',
      planFingerprintAtCapture: 'fp-a',
      measurement: buildBalanceSnapshotActual({
        asOfDate: '2026-05-31',
        pretax: 500_000,
        roth: 300_000,
        taxable: 180_000,
      }),
    };
    logActual(actualsStore, balanceActual);

    const [row] = reconcileActualsVsPredictions(predictionStore, actualsStore);
    expect(row.planFingerprintMatch).toBe(true);
    expect(row.predicted).toBe(920_000);
    expect(row.actual).toBe(980_000);
    expect(row.deltaAbsolute).toBe(60_000);
    expect(row.deltaPct).toBeCloseTo((60_000 / 920_000) * 100, 4);
    expect(row.notes).toHaveLength(0);
  });

  it('flags fingerprint mismatch when the plan has changed', () => {
    const predictionStore = createInMemoryPredictionLogStore();
    logPrediction(predictionStore, makePrediction({ planFingerprint: 'fp-old' }));

    const actualsStore = createInMemoryActualsLogStore();
    logActual(actualsStore, {
      capturedAt: '2026-06-01T00:00:00Z',
      planFingerprintAtCapture: 'fp-new',
      measurement: buildBalanceSnapshotActual({
        asOfDate: '2026-05-31',
        pretax: 500_000,
      }),
    });

    const [row] = reconcileActualsVsPredictions(predictionStore, actualsStore);
    expect(row.planFingerprintMatch).toBe(false);
    expect(row.notes[0]).toContain('plan changed');
  });

  it('handles monthly spending by annualizing the predicted value', () => {
    const predictionStore = createInMemoryPredictionLogStore();
    logPrediction(predictionStore, makePrediction());

    const actualsStore = createInMemoryActualsLogStore();
    logActual(actualsStore, {
      capturedAt: '2026-04-05T00:00:00Z',
      planFingerprintAtCapture: 'fp-a',
      measurement: buildMonthlySpendingActual({
        month: '2026-03',
        essentialSpent: 6_000,
        optionalSpent: 4_500,
      }),
    });

    const [row] = reconcileActualsVsPredictions(predictionStore, actualsStore);
    expect(row.metric).toBe('monthly_spending');
    // Annual median spending 120_000 / 12 = 10_000 predicted monthly.
    expect(row.predicted).toBe(10_000);
    expect(row.actual).toBe(10_500);
    expect(row.deltaAbsolute).toBe(500);
  });

  it('handles annual tax actuals against the matching year in the trajectory', () => {
    const predictionStore = createInMemoryPredictionLogStore();
    logPrediction(predictionStore, makePrediction());

    const actualsStore = createInMemoryActualsLogStore();
    logActual(actualsStore, {
      capturedAt: '2027-04-15T00:00:00Z',
      planFingerprintAtCapture: 'fp-a',
      measurement: buildAnnualTaxActual({ taxYear: 2027, federalTaxPaid: 26_000 }),
    });

    const [row] = reconcileActualsVsPredictions(predictionStore, actualsStore);
    expect(row.metric).toBe('annual_federal_tax');
    expect(row.predicted).toBe(24_000);
    expect(row.actual).toBe(26_000);
    expect(row.deltaAbsolute).toBe(2_000);
  });

  it('returns "no prior prediction" when actuals precede any prediction', () => {
    const predictionStore = createInMemoryPredictionLogStore();
    logPrediction(predictionStore, makePrediction({ timestamp: '2030-01-01T00:00:00Z' }));

    const actualsStore = createInMemoryActualsLogStore();
    logActual(actualsStore, {
      capturedAt: '2026-06-01T00:00:00Z',
      planFingerprintAtCapture: 'fp-a',
      measurement: buildBalanceSnapshotActual({ asOfDate: '2026-05-31', pretax: 1 }),
    });

    const [row] = reconcileActualsVsPredictions(predictionStore, actualsStore);
    expect(row.notes).toContain('no prior prediction found — cannot reconcile');
  });

  it('summarizeReconciliation reports mean and median delta% by metric', () => {
    const predictionStore = createInMemoryPredictionLogStore();
    logPrediction(predictionStore, makePrediction());

    const actualsStore = createInMemoryActualsLogStore();
    // Two balance snapshots: +$60k and -$30k vs $920k predicted.
    logActual(actualsStore, {
      capturedAt: '2026-06-01T00:00:00Z',
      planFingerprintAtCapture: 'fp-a',
      measurement: buildBalanceSnapshotActual({
        asOfDate: '2026-05-31',
        pretax: 500_000,
        roth: 300_000,
        taxable: 180_000,
      }),
    });
    logActual(actualsStore, {
      capturedAt: '2026-09-01T00:00:00Z',
      planFingerprintAtCapture: 'fp-a',
      measurement: buildBalanceSnapshotActual({
        asOfDate: '2026-08-31',
        pretax: 450_000,
        roth: 250_000,
        taxable: 190_000,
      }),
    });

    const rows = reconcileActualsVsPredictions(predictionStore, actualsStore);
    const summary = summarizeReconciliation(rows);
    expect(summary.totalRows).toBe(2);
    expect(summary.matchedFingerprintCount).toBe(2);
    const balanceMetric = summary.metricSummaries.find(
      (entry) => entry.metric === 'total_balance',
    );
    expect(balanceMetric).toBeDefined();
    expect(balanceMetric!.count).toBe(2);
    expect(balanceMetric!.meanDeltaPct).not.toBeNull();
  });
});
