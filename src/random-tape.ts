export const RANDOM_TAPE_SCHEMA_VERSION = 'retirement-random-tape-v1' as const;

export type RandomTapeAssetClass = 'US_EQUITY' | 'INTL_EQUITY' | 'BONDS' | 'CASH';

export type RandomTapeMarketState = 'normal' | 'down' | 'up';

export interface RandomTapeMarketYear {
  year: number;
  yearOffset: number;
  inflation: number;
  assetReturns: Record<RandomTapeAssetClass, number>;
  bucketReturns?: {
    pretax: number;
    roth: number;
    taxable: number;
    cash: number;
  };
  cashflow?: {
    adjustedWages: number;
    spendingCutActive: boolean;
    spendingCutTriggered: boolean;
    employee401kContribution: number;
    employerMatchContribution: number;
    hsaContribution: number;
    rothContributionFlow: number;
    socialSecurityIncome: number;
    windfallCashInflow: number;
    windfallDeployedToTaxable?: number;
    windfallInvestmentSleeveBalance?: number;
    homeSaleGrossProceeds: number;
    homeSaleSellingCosts: number;
    homeReplacementPurchaseCost: number;
    homeDownsizeNetLiquidity: number;
    spendingBeforeHealthcare: number;
    healthcarePremiumCost: number;
    ltcCost: number;
    hsaOffsetUsed: number;
    hsaLtcOffsetUsed: number;
    ltcCostRemainingAfterHsa: number;
    hsaBalanceEnd: number;
    federalTax: number;
    irmaaTier: number;
    rmdWithdrawn: number;
    rmdSurplusToCash: number;
    withdrawalCash: number;
    withdrawalTaxable: number;
    withdrawalPretax: number;
    withdrawalRoth: number;
    remainingWithdrawalNeed: number;
    rothConversion: number;
    totalSpending: number;
    totalIncome: number;
  };
  marketState: RandomTapeMarketState;
}

export interface RandomTapeTrial {
  trialIndex: number;
  trialSeed: number;
  ltcEventOccurs: boolean;
  marketPath: RandomTapeMarketYear[];
  reference?: {
    success: boolean;
    failureYear: number | null;
    endingWealth: number;
    spendingCutsTriggered: number;
    irmaaTriggered: boolean;
    homeSaleDependent: boolean;
    inheritanceDependent: boolean;
    rothDepletedEarly: boolean;
    yearly: Array<{
      year: number;
      totalAssets: number;
      pretaxBalanceEnd: number;
      taxableBalanceEnd: number;
      rothBalanceEnd: number;
      cashBalanceEnd: number;
      spending: number;
      income: number;
      federalTax: number;
    }>;
  };
}

export interface SimulationRandomTapeV1 {
  schemaVersion: typeof RANDOM_TAPE_SCHEMA_VERSION;
  generatedBy: 'typescript';
  createdAtIso: string;
  label: string;
  simulationMode: 'planner_enhanced' | 'raw_simulation';
  seed: number;
  trialCount: number;
  planningHorizonYears: number;
  assumptionsVersion: string;
  samplingStrategy: 'mc' | 'qmc';
  returnModel: {
    useHistoricalBootstrap: boolean;
    historicalBootstrapBlockLength: number;
    useCorrelatedReturns: boolean;
    equityTailMode: 'normal' | 'crash_mixture';
  };
  trials: RandomTapeTrial[];
}

export type SimulationRandomTape = SimulationRandomTapeV1;

export interface RandomTapeController {
  mode: 'record' | 'replay';
  label?: string;
  tape?: SimulationRandomTape;
  onRecord?: (tape: SimulationRandomTape) => void;
}

export function assertRandomTape(value: unknown): asserts value is SimulationRandomTape {
  if (!value || typeof value !== 'object') {
    throw new Error('Random tape must be a JSON object');
  }
  const tape = value as Partial<SimulationRandomTape>;
  if (tape.schemaVersion !== RANDOM_TAPE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported random tape schema: ${String(tape.schemaVersion ?? 'missing')}`,
    );
  }
  if (!Array.isArray(tape.trials)) {
    throw new Error('Random tape is missing trials[]');
  }
}

export function buildRandomTapeTrialMap(tape: SimulationRandomTape) {
  return new Map(tape.trials.map((trial) => [trial.trialIndex, trial]));
}
