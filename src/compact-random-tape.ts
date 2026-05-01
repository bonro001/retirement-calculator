import type {
  RandomTapeAssetClass,
  RandomTapeMarketState,
  SimulationRandomTape,
} from './random-tape';

export const COMPACT_SUMMARY_RANDOM_TAPE_SCHEMA_VERSION =
  'compact-summary-random-tape-v1' as const;

export const COMPACT_SUMMARY_TAPE_YEAR_FIELDS = [
  'year',
  'yearOffset',
  'inflation',
  'US_EQUITY',
  'INTL_EQUITY',
  'BONDS',
  'CASH',
  'bucketPretax',
  'bucketRoth',
  'bucketTaxable',
  'bucketCash',
] as const;

const ASSET_CLASSES: RandomTapeAssetClass[] = [
  'US_EQUITY',
  'INTL_EQUITY',
  'BONDS',
  'CASH',
];

const MARKET_STATE_TO_CODE: Record<RandomTapeMarketState, number> = {
  normal: 0,
  down: 1,
  up: 2,
};

const CODE_TO_MARKET_STATE: Record<number, RandomTapeMarketState> = {
  0: 'normal',
  1: 'down',
  2: 'up',
};

export interface CompactSummaryRandomTape {
  schemaVersion: typeof COMPACT_SUMMARY_RANDOM_TAPE_SCHEMA_VERSION;
  metadata: Omit<SimulationRandomTape, 'trials'>;
  trialIndex: Int32Array;
  trialSeed: Float64Array;
  ltcEventOccurs: Uint8Array;
  cashflowPresent: Uint8Array;
  marketState: Uint8Array;
  marketYears: Float64Array;
  yearFieldCount: typeof COMPACT_SUMMARY_TAPE_YEAR_FIELDS.length;
}

export function compactSummaryRandomTapeByteLength(
  tape: CompactSummaryRandomTape,
) {
  return (
    tape.trialIndex.byteLength +
    tape.trialSeed.byteLength +
    tape.ltcEventOccurs.byteLength +
    tape.cashflowPresent.byteLength +
    tape.marketState.byteLength +
    tape.marketYears.byteLength
  );
}

export function packSummaryRandomTape(
  tape: SimulationRandomTape,
): CompactSummaryRandomTape {
  const { trials, ...metadata } = tape;
  const trialCount = trials.length;
  const yearsPerTrial = tape.planningHorizonYears;
  const yearFieldCount = COMPACT_SUMMARY_TAPE_YEAR_FIELDS.length;
  const rowCount = trialCount * yearsPerTrial;

  const trialIndex = new Int32Array(trialCount);
  const trialSeed = new Float64Array(trialCount);
  const ltcEventOccurs = new Uint8Array(trialCount);
  const cashflowPresent = new Uint8Array(rowCount);
  const marketState = new Uint8Array(rowCount);
  const marketYears = new Float64Array(rowCount * yearFieldCount);

  trials.forEach((trial, trialOffset) => {
    if (trial.marketPath.length !== yearsPerTrial) {
      throw new Error(
        `Compact tape requires fixed marketPath length: trial ${trial.trialIndex} has ${trial.marketPath.length}, expected ${yearsPerTrial}`,
      );
    }
    trialIndex[trialOffset] = trial.trialIndex;
    trialSeed[trialOffset] = trial.trialSeed;
    ltcEventOccurs[trialOffset] = trial.ltcEventOccurs ? 1 : 0;

    trial.marketPath.forEach((year, yearOffset) => {
      const row = trialOffset * yearsPerTrial + yearOffset;
      const base = row * yearFieldCount;
      marketYears[base] = year.year;
      marketYears[base + 1] = year.yearOffset;
      marketYears[base + 2] = year.inflation;
      ASSET_CLASSES.forEach((assetClass, assetOffset) => {
        marketYears[base + 3 + assetOffset] = year.assetReturns[assetClass];
      });
      marketYears[base + 7] = year.bucketReturns?.pretax ?? Number.NaN;
      marketYears[base + 8] = year.bucketReturns?.roth ?? Number.NaN;
      marketYears[base + 9] = year.bucketReturns?.taxable ?? Number.NaN;
      marketYears[base + 10] = year.bucketReturns?.cash ?? Number.NaN;
      marketState[row] = MARKET_STATE_TO_CODE[year.marketState];
      cashflowPresent[row] = year.cashflow ? 1 : 0;
    });
  });

  return {
    schemaVersion: COMPACT_SUMMARY_RANDOM_TAPE_SCHEMA_VERSION,
    metadata,
    trialIndex,
    trialSeed,
    ltcEventOccurs,
    cashflowPresent,
    marketState,
    marketYears,
    yearFieldCount,
  };
}

export function unpackSummaryRandomTape(
  compact: CompactSummaryRandomTape,
): SimulationRandomTape {
  const yearsPerTrial = compact.metadata.planningHorizonYears;
  const yearFieldCount = compact.yearFieldCount;
  if (yearFieldCount !== COMPACT_SUMMARY_TAPE_YEAR_FIELDS.length) {
    throw new Error(
      `Unsupported compact tape year field count: ${String(yearFieldCount)}`,
    );
  }

  return {
    ...compact.metadata,
    trials: Array.from(compact.trialIndex, (trialIndex, trialOffset) => ({
      trialIndex,
      trialSeed: compact.trialSeed[trialOffset],
      ltcEventOccurs: compact.ltcEventOccurs[trialOffset] === 1,
      marketPath: Array.from({ length: yearsPerTrial }, (_, yearOffset) => {
        const row = trialOffset * yearsPerTrial + yearOffset;
        const base = row * yearFieldCount;
        const bucketPretax = compact.marketYears[base + 7];
        const bucketRoth = compact.marketYears[base + 8];
        const bucketTaxable = compact.marketYears[base + 9];
        const bucketCash = compact.marketYears[base + 10];
        return {
          year: compact.marketYears[base],
          yearOffset: compact.marketYears[base + 1],
          inflation: compact.marketYears[base + 2],
          assetReturns: {
            US_EQUITY: compact.marketYears[base + 3],
            INTL_EQUITY: compact.marketYears[base + 4],
            BONDS: compact.marketYears[base + 5],
            CASH: compact.marketYears[base + 6],
          },
          bucketReturns:
            Number.isFinite(bucketPretax) &&
            Number.isFinite(bucketRoth) &&
            Number.isFinite(bucketTaxable) &&
            Number.isFinite(bucketCash)
              ? {
                  pretax: bucketPretax,
                  roth: bucketRoth,
                  taxable: bucketTaxable,
                  cash: bucketCash,
                }
              : undefined,
          cashflow: compact.cashflowPresent[row]
            ? ({} as NonNullable<
                SimulationRandomTape['trials'][number]['marketPath'][number]['cashflow']
              >)
            : undefined,
          marketState: CODE_TO_MARKET_STATE[compact.marketState[row]] ?? 'normal',
        };
      }),
    })),
  };
}
