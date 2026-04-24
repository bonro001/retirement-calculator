import type { PredictionLogStore, PredictionRecord } from './prediction-log';

// CALIBRATION_WORKPLAN step 11: detect when plan INPUTS drift between
// two evaluations. The reconciliation layer already flags when actuals
// were measured under a different plan fingerprint; this detector
// produces a human-readable diff of what specifically changed, so a
// dashboard can render "you moved your retirement date 6 months later"
// instead of just "plan changed."
//
// Pure function of the prediction log. No persistence of its own.

export type BehaviorChangeCategory =
  | 'retirement_timing'
  | 'spending'
  | 'accounts'
  | 'income'
  | 'stressors_responses'
  | 'assumptions'
  | 'other';

export interface BehaviorChange {
  category: BehaviorChangeCategory;
  field: string;
  before: string | number | null;
  after: string | number | null;
  description: string;
  // Magnitude in the units of the field (% or $), signed. Positive means
  // "moved in the 'bigger / later / more' direction."
  signedDelta: number | null;
}

export interface BehaviorChangeDiff {
  fromTimestamp: string;
  toTimestamp: string;
  fromFingerprint: string;
  toFingerprint: string;
  changes: BehaviorChange[];
  summary: string;
}

function formatDate(isoOrPlain: string): string {
  try {
    const d = new Date(isoOrPlain);
    if (Number.isNaN(d.valueOf())) return isoOrPlain;
    return d.toISOString().slice(0, 10);
  } catch {
    return isoOrPlain;
  }
}

function maybeNumericDelta(
  before: string | number | null,
  after: string | number | null,
): number | null {
  if (typeof before !== 'number' || typeof after !== 'number') return null;
  return after - before;
}

// Compare two prediction records and emit a list of user-meaningful
// changes. Ignores timestamps and derived outputs — only input fields
// surface.
export function diffPredictions(
  from: PredictionRecord,
  to: PredictionRecord,
): BehaviorChangeDiff {
  const changes: BehaviorChange[] = [];
  const a = from.inputs.seedData;
  const b = to.inputs.seedData;

  // Retirement timing.
  if (a.income.salaryEndDate !== b.income.salaryEndDate) {
    const deltaMs =
      new Date(b.income.salaryEndDate).valueOf() -
      new Date(a.income.salaryEndDate).valueOf();
    const deltaMonths = Math.round(deltaMs / (1000 * 60 * 60 * 24 * 30.44));
    changes.push({
      category: 'retirement_timing',
      field: 'income.salaryEndDate',
      before: formatDate(a.income.salaryEndDate),
      after: formatDate(b.income.salaryEndDate),
      description: `Retirement date shifted ${deltaMonths >= 0 ? 'later' : 'earlier'} by ${Math.abs(deltaMonths)} month${
        Math.abs(deltaMonths) === 1 ? '' : 's'
      }`,
      signedDelta: deltaMonths,
    });
  }

  if (a.household.planningAge !== b.household.planningAge) {
    changes.push({
      category: 'retirement_timing',
      field: 'household.planningAge',
      before: a.household.planningAge,
      after: b.household.planningAge,
      description: `Planning-to age moved from ${a.household.planningAge} to ${b.household.planningAge}`,
      signedDelta: b.household.planningAge - a.household.planningAge,
    });
  }

  // Spending.
  for (const bucket of ['essentialMonthly', 'optionalMonthly'] as const) {
    if (a.spending[bucket] !== b.spending[bucket]) {
      changes.push({
        category: 'spending',
        field: `spending.${bucket}`,
        before: a.spending[bucket],
        after: b.spending[bucket],
        description: `${bucket === 'essentialMonthly' ? 'Essential' : 'Optional'} monthly spend ${
          b.spending[bucket] > a.spending[bucket] ? 'up' : 'down'
        } from $${a.spending[bucket].toLocaleString()} to $${b.spending[bucket].toLocaleString()}`,
        signedDelta: b.spending[bucket] - a.spending[bucket],
      });
    }
  }
  if (a.spending.annualTaxesInsurance !== b.spending.annualTaxesInsurance) {
    changes.push({
      category: 'spending',
      field: 'spending.annualTaxesInsurance',
      before: a.spending.annualTaxesInsurance,
      after: b.spending.annualTaxesInsurance,
      description: `Annual taxes + insurance moved from $${a.spending.annualTaxesInsurance.toLocaleString()} to $${b.spending.annualTaxesInsurance.toLocaleString()}`,
      signedDelta: b.spending.annualTaxesInsurance - a.spending.annualTaxesInsurance,
    });
  }

  // Account balances.
  const bucketKeys = ['pretax', 'roth', 'taxable', 'cash', 'hsa'] as const;
  for (const key of bucketKeys) {
    const before = a.accounts[key]?.balance;
    const after = b.accounts[key]?.balance;
    if (typeof before === 'number' && typeof after === 'number' && before !== after) {
      changes.push({
        category: 'accounts',
        field: `accounts.${key}.balance`,
        before,
        after,
        description: `${key} balance moved from $${Math.round(before).toLocaleString()} to $${Math.round(after).toLocaleString()}`,
        signedDelta: after - before,
      });
    }
  }

  // Income — salary and windfall list.
  if (a.income.salaryAnnual !== b.income.salaryAnnual) {
    changes.push({
      category: 'income',
      field: 'income.salaryAnnual',
      before: a.income.salaryAnnual,
      after: b.income.salaryAnnual,
      description: `Annual salary moved from $${a.income.salaryAnnual.toLocaleString()} to $${b.income.salaryAnnual.toLocaleString()}`,
      signedDelta: b.income.salaryAnnual - a.income.salaryAnnual,
    });
  }

  const aWindfallNames = new Set((a.income.windfalls ?? []).map((w) => w.name));
  const bWindfallNames = new Set((b.income.windfalls ?? []).map((w) => w.name));
  for (const name of bWindfallNames) {
    if (!aWindfallNames.has(name)) {
      const w = b.income.windfalls.find((x) => x.name === name);
      changes.push({
        category: 'income',
        field: `income.windfalls.${name}`,
        before: null,
        after: w ? `${w.year}: $${Math.round(w.amount).toLocaleString()}` : name,
        description: `Added windfall "${name}"${w ? ` in ${w.year} for $${Math.round(w.amount).toLocaleString()}` : ''}`,
        signedDelta: w?.amount ?? null,
      });
    }
  }
  for (const name of aWindfallNames) {
    if (!bWindfallNames.has(name)) {
      const w = a.income.windfalls.find((x) => x.name === name);
      changes.push({
        category: 'income',
        field: `income.windfalls.${name}`,
        before: w ? `${w.year}: $${Math.round(w.amount).toLocaleString()}` : name,
        after: null,
        description: `Removed windfall "${name}"`,
        signedDelta: w ? -w.amount : null,
      });
    }
  }

  // Stressors / responses (simple count and id diff).
  const aStressorIds = new Set(a.stressors.map((s) => s.id));
  const bStressorIds = new Set(b.stressors.map((s) => s.id));
  const addedStressors = [...bStressorIds].filter((id) => !aStressorIds.has(id));
  const removedStressors = [...aStressorIds].filter((id) => !bStressorIds.has(id));
  if (addedStressors.length || removedStressors.length) {
    const parts: string[] = [];
    if (addedStressors.length) parts.push(`added: ${addedStressors.join(', ')}`);
    if (removedStressors.length) parts.push(`removed: ${removedStressors.join(', ')}`);
    changes.push({
      category: 'stressors_responses',
      field: 'stressors',
      before: [...aStressorIds].sort().join(','),
      after: [...bStressorIds].sort().join(','),
      description: `Stressor set changed (${parts.join('; ')})`,
      signedDelta: bStressorIds.size - aStressorIds.size,
    });
  }

  // Assumption changes (return means, vol, inflation).
  const aAssumptions = from.inputs.assumptions;
  const bAssumptions = to.inputs.assumptions;
  const assumptionFields: Array<keyof typeof aAssumptions> = [
    'equityMean',
    'internationalEquityMean',
    'bondMean',
    'cashMean',
    'inflation',
    'simulationRuns',
  ];
  for (const field of assumptionFields) {
    const before = aAssumptions[field];
    const after = bAssumptions[field];
    if (typeof before === 'number' && typeof after === 'number' && before !== after) {
      const isRate = field !== 'simulationRuns';
      changes.push({
        category: 'assumptions',
        field: `assumptions.${String(field)}`,
        before,
        after,
        description: isRate
          ? `${String(field)} moved from ${(before * 100).toFixed(2)}% to ${(after * 100).toFixed(2)}%`
          : `${String(field)} moved from ${before} to ${after}`,
        signedDelta: maybeNumericDelta(before, after),
      });
    }
  }

  if (from.engineVersion !== to.engineVersion) {
    changes.push({
      category: 'assumptions',
      field: 'engineVersion',
      before: from.engineVersion,
      after: to.engineVersion,
      description: `Engine version changed from ${from.engineVersion} to ${to.engineVersion}`,
      signedDelta: null,
    });
  }

  const summary =
    changes.length === 0
      ? 'No plan changes detected between these two evaluations.'
      : `${changes.length} plan change${changes.length === 1 ? '' : 's'} detected: ${
          Array.from(new Set(changes.map((c) => c.category))).join(', ')
        }.`;

  return {
    fromTimestamp: from.timestamp,
    toTimestamp: to.timestamp,
    fromFingerprint: from.planFingerprint,
    toFingerprint: to.planFingerprint,
    changes,
    summary,
  };
}

// Given the full prediction log, return a diff for every consecutive
// pair of records that carries a different fingerprint.
export function detectBehaviorChanges(
  store: PredictionLogStore,
): BehaviorChangeDiff[] {
  const records = [...store.readAll()].sort(
    (left, right) =>
      new Date(left.timestamp).valueOf() - new Date(right.timestamp).valueOf(),
  );
  const diffs: BehaviorChangeDiff[] = [];
  for (let i = 1; i < records.length; i++) {
    const prior = records[i - 1];
    const current = records[i];
    if (prior.planFingerprint === current.planFingerprint) continue;
    diffs.push(diffPredictions(prior, current));
  }
  return diffs;
}
