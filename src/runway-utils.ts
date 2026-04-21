import type { PathResult, SeedData } from './types';

const CASH_SYMBOL = 'CASH';

const roundMoney = (value: number) => Number(value.toFixed(2));

export function estimateRunwayLiquidity(data: SeedData) {
  const directCash = data.accounts.cash.balance;
  const sleeveBuckets: Array<keyof SeedData['accounts']> = ['pretax', 'roth', 'taxable', 'hsa'];
  const sleeveCash = sleeveBuckets.reduce((sum, bucketKey) => {
    const bucketState = data.accounts[bucketKey];
    if (!bucketState || !(bucketState.balance > 0)) {
      return sum;
    }
    const cashWeight = bucketState.targetAllocation[CASH_SYMBOL] ?? 0;
    if (!(cashWeight > 0)) {
      return sum;
    }
    return sum + bucketState.balance * cashWeight;
  }, 0);

  return roundMoney(directCash + sleeveCash);
}

export function calculateRunwayGapMetrics(input: {
  data: SeedData;
  targetMonths: number;
}) {
  const essentialWithFixedMonthly =
    input.data.spending.essentialMonthly + input.data.spending.annualTaxesInsurance / 12;
  const targetCashRunway = essentialWithFixedMonthly * input.targetMonths;
  const acceptableRunwayAssets = [
    {
      source: 'cash',
      liquidityDollars: roundMoney(input.data.accounts.cash.balance),
      note: 'Direct cash bucket is fully eligible runway liquidity.',
    },
    ...(['pretax', 'roth', 'taxable', 'hsa'] as const).map((bucket) => ({
      source: `${bucket}_cash_sleeve`,
      liquidityDollars: roundMoney(
        (input.data.accounts[bucket]?.balance ?? 0) *
          ((input.data.accounts[bucket]?.targetAllocation[CASH_SYMBOL] ?? 0)),
      ),
      note: `Cash sleeve extracted from ${bucket} allocation.`,
    })),
  ];
  const currentRunwayLiquidity = roundMoney(
    acceptableRunwayAssets.reduce((sum, asset) => sum + asset.liquidityDollars, 0),
  );
  const cashGap = Math.max(0, targetCashRunway - currentRunwayLiquidity);
  const runwayGapMonths =
    essentialWithFixedMonthly > 0 ? roundMoney(cashGap / essentialWithFixedMonthly) : 0;

  return {
    essentialWithFixedMonthly: roundMoney(essentialWithFixedMonthly),
    targetCashRunway: roundMoney(targetCashRunway),
    currentRunwayLiquidity,
    cashGap: roundMoney(cashGap),
    runwayGapMonths,
    acceptableRunwayAssets,
  };
}

export interface RunwayBridgeRiskDelta {
  earlyFailureProbabilityDelta: number;
  worstDecileEndingWealthDelta: number;
  spendingCutRateDelta: number;
  equitySalesInAdverseEarlyYearsRateDelta: number;
  provenBenefit: boolean;
}

function resolvePathRiskMetrics(path: PathResult) {
  return {
    earlyFailureProbability:
      path.riskMetrics?.earlyFailureProbability ?? Math.max(0, 1 - path.successRate),
    worstDecileEndingWealth:
      path.riskMetrics?.worstDecileEndingWealth ?? path.tenthPercentileEndingWealth ?? 0,
    equitySalesInAdverseEarlyYearsRate:
      path.riskMetrics?.equitySalesInAdverseEarlyYearsRate ?? 0,
  };
}

export function evaluateRunwayBridgeRiskDelta(input: {
  baselinePath: PathResult;
  counterfactualPath: PathResult;
}) {
  const baselineRiskMetrics = resolvePathRiskMetrics(input.baselinePath);
  const counterfactualRiskMetrics = resolvePathRiskMetrics(input.counterfactualPath);
  const delta: RunwayBridgeRiskDelta = {
    earlyFailureProbabilityDelta:
      counterfactualRiskMetrics.earlyFailureProbability -
      baselineRiskMetrics.earlyFailureProbability,
    worstDecileEndingWealthDelta:
      counterfactualRiskMetrics.worstDecileEndingWealth -
      baselineRiskMetrics.worstDecileEndingWealth,
    spendingCutRateDelta:
      input.counterfactualPath.spendingCutRate - input.baselinePath.spendingCutRate,
    equitySalesInAdverseEarlyYearsRateDelta:
      counterfactualRiskMetrics.equitySalesInAdverseEarlyYearsRate -
      baselineRiskMetrics.equitySalesInAdverseEarlyYearsRate,
    provenBenefit: false,
  };

  const improvesEarlyFailure = delta.earlyFailureProbabilityDelta <= -0.0025;
  const improvesWorstDecileWealth = delta.worstDecileEndingWealthDelta >= 5_000;
  const improvesSpendingCuts = delta.spendingCutRateDelta <= -0.01;
  const improvesAdverseSales = delta.equitySalesInAdverseEarlyYearsRateDelta <= -0.01;
  delta.provenBenefit =
    improvesEarlyFailure ||
    improvesWorstDecileWealth ||
    improvesSpendingCuts ||
    improvesAdverseSales;

  return delta;
}
