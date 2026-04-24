// Deterministic year-by-year replay of a Trinity-Study-shaped retirement on
// historical market data. Intentionally simpler than the full simulation
// engine — no tax, no RMDs, no SS, no healthcare — because the whole point
// is to validate sequence-of-returns math in isolation. 1966-era tax law
// bears almost no resemblance to today's, so mixing the full engine in
// would conflate modeling-error with data-vintage-error and defeat the
// purpose of the backtest.

export interface CohortSpec {
  // Human-readable label (e.g., "1966 retiree, 60/40, 4% SWR").
  label: string;
  // First full year of retirement.
  startYear: number;
  // How many years the retiree draws from the portfolio.
  durationYears: number;
  // Starting nominal portfolio balance.
  startingBalance: number;
  // Initial annual withdrawal in nominal dollars. After year 1, withdrawal
  // is inflated each year by realized CPI (Trinity/Bengen convention).
  initialAnnualWithdrawal: number;
  // Portfolio allocation (must sum to 1.0). Rebalanced annually.
  allocation: {
    stocks: number;
    bonds: number;
  };
  // Historical returns indexed by calendar year. Each entry: stock total
  // return, bond total return, CPI inflation, all as decimals (0.07 = +7%).
  returnsByYear: Record<
    number,
    {
      stocks: number;
      bonds: number;
      inflation: number;
    }
  >;
}

export interface CohortReplayYear {
  year: number;
  age: number; // assumes retirement age 65 at startYear (purely cosmetic here)
  startBalance: number;
  withdrawal: number;
  portfolioReturn: number;
  endBalance: number;
  realEndBalance: number; // deflated back to year-0 dollars
  cumulativeInflation: number;
}

export interface CohortReplayResult {
  label: string;
  survived: boolean;
  yearsFunded: number; // number of full years the portfolio covered the withdrawal
  finalBalance: number;
  finalRealBalance: number;
  peakBalance: number;
  peakYear: number;
  years: CohortReplayYear[];
}

export function replayCohort(spec: CohortSpec): CohortReplayResult {
  if (
    Math.abs(spec.allocation.stocks + spec.allocation.bonds - 1.0) > 1e-6
  ) {
    throw new Error(
      `Allocation must sum to 1.0: stocks=${spec.allocation.stocks}, bonds=${spec.allocation.bonds}`,
    );
  }

  const years: CohortReplayYear[] = [];
  let balance = spec.startingBalance;
  let currentWithdrawal = spec.initialAnnualWithdrawal;
  let cumulativeInflation = 1.0;
  let peakBalance = balance;
  let peakYear = spec.startYear - 1;
  let survived = true;
  let yearsFunded = 0;

  for (let i = 0; i < spec.durationYears; i++) {
    const year = spec.startYear + i;
    const returns = spec.returnsByYear[year];
    if (!returns) {
      throw new Error(
        `Cohort "${spec.label}" missing return data for year ${year}`,
      );
    }

    const startBalance = balance;
    // Trinity convention: withdraw at start of year, invest residual at
    // that year's blended return. Keeps the math simple and matches the
    // most-cited Trinity / Bengen results.
    let withdrawal = currentWithdrawal;
    if (withdrawal > balance) {
      // Portfolio can't cover full withdrawal — take what's left and mark
      // failure for subsequent years.
      withdrawal = Math.max(0, balance);
      survived = false;
    }
    balance -= withdrawal;
    const portfolioReturn =
      spec.allocation.stocks * returns.stocks +
      spec.allocation.bonds * returns.bonds;
    balance = balance * (1 + portfolioReturn);
    cumulativeInflation *= 1 + returns.inflation;

    const realEndBalance = balance / cumulativeInflation;

    if (balance > peakBalance) {
      peakBalance = balance;
      peakYear = year;
    }
    if (survived && balance > 0) {
      yearsFunded = i + 1;
    }

    years.push({
      year,
      age: 65 + i,
      startBalance,
      withdrawal,
      portfolioReturn,
      endBalance: balance,
      realEndBalance,
      cumulativeInflation,
    });

    // Inflate next year's withdrawal by this year's CPI.
    currentWithdrawal *= 1 + returns.inflation;
  }

  return {
    label: spec.label,
    survived,
    yearsFunded,
    finalBalance: balance,
    finalRealBalance: balance / cumulativeInflation,
    peakBalance,
    peakYear,
    years,
  };
}
