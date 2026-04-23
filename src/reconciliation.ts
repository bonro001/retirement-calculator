import type { ActualsRecord, ActualsLogStore } from './actuals-log';
import type { PredictionLogStore, PredictionRecord } from './prediction-log';

// CALIBRATION_WORKPLAN step 6: for each actuals row, find the most recent
// prior prediction with the same plan fingerprint and compute the delta
// between what we predicted for that year/metric and what actually
// happened. Produces a ReconciliationRow per (prediction, actual) match.
//
// When fingerprints don't line up, the row gets tagged 'plan_changed' —
// that's the signal the user's plan drifted between the prediction and
// the observation, and the miss isn't model error, it's plan-change
// reality.

export interface ReconciliationRow {
  actualsTimestamp: string;
  predictionTimestamp: string;
  planFingerprintMatch: boolean;
  horizonDays: number;
  metric:
    | 'total_balance'
    | 'monthly_spending'
    | 'annual_federal_tax'
    | 'life_event';
  year: number;
  predicted: number | null;
  actual: number;
  deltaAbsolute: number | null;
  deltaPct: number | null;
  notes: string[];
}

// Find the most recent prediction whose timestamp precedes the actuals
// capture and whose fingerprint matches. If no match, return the most
// recent prior prediction regardless of fingerprint and flag it.
function findBestPriorPrediction(
  predictions: PredictionRecord[],
  actualsCapturedAt: string,
  targetFingerprint: string,
): { prediction: PredictionRecord | null; fingerprintMatch: boolean } {
  const actualsMs = new Date(actualsCapturedAt).valueOf();
  const priorPredictions = predictions
    .filter((prediction) => new Date(prediction.timestamp).valueOf() <= actualsMs)
    .sort(
      (left, right) =>
        new Date(right.timestamp).valueOf() -
        new Date(left.timestamp).valueOf(),
    );
  if (!priorPredictions.length) {
    return { prediction: null, fingerprintMatch: false };
  }
  const fingerprintMatched = priorPredictions.find(
    (prediction) => prediction.planFingerprint === targetFingerprint,
  );
  if (fingerprintMatched) {
    return { prediction: fingerprintMatched, fingerprintMatch: true };
  }
  return { prediction: priorPredictions[0], fingerprintMatch: false };
}

function yearOfActual(actual: ActualsRecord): number {
  const m = actual.measurement;
  if (m.kind === 'annual_tax') return m.taxYear;
  if (m.kind === 'balance_snapshot') return new Date(m.asOfDate).getFullYear();
  if (m.kind === 'monthly_spending') return Number(m.month.slice(0, 4));
  return new Date(m.eventDate).getFullYear();
}

function predictedForYear(
  prediction: PredictionRecord,
  year: number,
  field: 'medianAssets' | 'medianSpending' | 'medianFederalTax' | 'medianIncome',
): number | null {
  const snapshot = prediction.yearlyTrajectory.find((entry) => entry.year === year);
  if (!snapshot) return null;
  return snapshot[field];
}

function computePct(actual: number, predicted: number | null): number | null {
  if (predicted === null || predicted === 0) return null;
  return ((actual - predicted) / predicted) * 100;
}

export function reconcileActualsVsPredictions(
  predictionStore: PredictionLogStore,
  actualsStore: ActualsLogStore,
): ReconciliationRow[] {
  const predictions = predictionStore.readAll();
  const actuals = actualsStore.readAll();
  const rows: ReconciliationRow[] = [];

  for (const actual of actuals) {
    const year = yearOfActual(actual);
    const { prediction, fingerprintMatch } = findBestPriorPrediction(
      predictions,
      actual.capturedAt,
      actual.planFingerprintAtCapture,
    );
    const notes: string[] = [];
    if (!prediction) {
      notes.push('no prior prediction found — cannot reconcile');
    } else if (!fingerprintMatch) {
      notes.push(
        `plan changed between prediction and actuals (prediction fp ${prediction.planFingerprint}; actuals fp ${actual.planFingerprintAtCapture})`,
      );
    }
    const horizonDays = prediction
      ? Math.round(
          (new Date(actual.capturedAt).valueOf() -
            new Date(prediction.timestamp).valueOf()) /
            (1000 * 60 * 60 * 24),
        )
      : 0;

    const measurement = actual.measurement;
    if (measurement.kind === 'balance_snapshot') {
      const predicted = prediction
        ? predictedForYear(prediction, year, 'medianAssets')
        : null;
      rows.push({
        actualsTimestamp: actual.capturedAt,
        predictionTimestamp: prediction?.timestamp ?? '',
        planFingerprintMatch: fingerprintMatch,
        horizonDays,
        metric: 'total_balance',
        year,
        predicted,
        actual: measurement.totalBalance,
        deltaAbsolute:
          predicted !== null ? measurement.totalBalance - predicted : null,
        deltaPct: computePct(measurement.totalBalance, predicted),
        notes,
      });
    } else if (measurement.kind === 'monthly_spending') {
      // Our engine reports annual median spending. Compare MONTHLY actual
      // to annualMedian/12 for a per-month comparison.
      const annualPredicted = prediction
        ? predictedForYear(prediction, year, 'medianSpending')
        : null;
      const monthlyPredicted =
        annualPredicted !== null ? annualPredicted / 12 : null;
      rows.push({
        actualsTimestamp: actual.capturedAt,
        predictionTimestamp: prediction?.timestamp ?? '',
        planFingerprintMatch: fingerprintMatch,
        horizonDays,
        metric: 'monthly_spending',
        year,
        predicted: monthlyPredicted,
        actual: measurement.totalSpent,
        deltaAbsolute:
          monthlyPredicted !== null
            ? measurement.totalSpent - monthlyPredicted
            : null,
        deltaPct: computePct(measurement.totalSpent, monthlyPredicted),
        notes,
      });
    } else if (measurement.kind === 'annual_tax') {
      const predicted = prediction
        ? predictedForYear(prediction, year, 'medianFederalTax')
        : null;
      rows.push({
        actualsTimestamp: actual.capturedAt,
        predictionTimestamp: prediction?.timestamp ?? '',
        planFingerprintMatch: fingerprintMatch,
        horizonDays,
        metric: 'annual_federal_tax',
        year,
        predicted,
        actual: measurement.federalTaxPaid,
        deltaAbsolute:
          predicted !== null ? measurement.federalTaxPaid - predicted : null,
        deltaPct: computePct(measurement.federalTaxPaid, predicted),
        notes,
      });
    } else if (measurement.kind === 'life_event') {
      // Life events don't have a per-year predicted metric — they're
      // journal entries. Reconcile just to attach the horizon + note.
      rows.push({
        actualsTimestamp: actual.capturedAt,
        predictionTimestamp: prediction?.timestamp ?? '',
        planFingerprintMatch: fingerprintMatch,
        horizonDays,
        metric: 'life_event',
        year,
        predicted: null,
        actual: measurement.amountSigned,
        deltaAbsolute: null,
        deltaPct: null,
        notes: [
          `${measurement.category}: ${measurement.description}`,
          ...notes,
        ],
      });
    }
  }

  return rows;
}

export interface ReconciliationSummary {
  totalRows: number;
  matchedFingerprintCount: number;
  driftedFingerprintCount: number;
  metricSummaries: Array<{
    metric: ReconciliationRow['metric'];
    count: number;
    meanDeltaPct: number | null;
    medianDeltaPct: number | null;
  }>;
}

// Aggregate summary over a reconciliation set. Useful for "how is the
// engine biased overall" reporting.
export function summarizeReconciliation(
  rows: ReconciliationRow[],
): ReconciliationSummary {
  const matched = rows.filter((row) => row.planFingerprintMatch).length;
  const drifted = rows.length - matched;

  const byMetric = new Map<ReconciliationRow['metric'], number[]>();
  for (const row of rows) {
    if (row.deltaPct === null) continue;
    const existing = byMetric.get(row.metric) ?? [];
    existing.push(row.deltaPct);
    byMetric.set(row.metric, existing);
  }

  const metricSummaries = Array.from(byMetric.entries()).map(
    ([metric, deltas]) => {
      const sorted = [...deltas].sort((left, right) => left - right);
      const meanDeltaPct =
        deltas.length > 0
          ? deltas.reduce((sum, x) => sum + x, 0) / deltas.length
          : null;
      const medianDeltaPct = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null;
      return {
        metric,
        count: deltas.length,
        meanDeltaPct,
        medianDeltaPct,
      };
    },
  );

  return {
    totalRows: rows.length,
    matchedFingerprintCount: matched,
    driftedFingerprintCount: drifted,
    metricSummaries,
  };
}
