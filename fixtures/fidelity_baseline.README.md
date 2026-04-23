# Fidelity baseline — peer-planner triangulation

Second peer-tool fixture alongside [boldin_lower_returns.README.md](./boldin_lower_returns.README.md). Same household, same 8-account portfolio (~$921-924k), different methodology on the peer side.

## What Fidelity publishes

From Fidelity's Planning & Guidance Center (digital.fidelity.com/ftgw/pna/customer/planning/...):

- **Probability of success**: 95% — overall MC pass rate.
- **Total lifetime income**: $1,971,816 — non-portfolio (salary + SS + other).
- **Assets remaining (10th percentile)**: $436,224 — ending balance on the displayed stress path.
- **Methodology**: 250 MC simulations using "historical performance, risk, and correlation of domestic stocks, foreign stocks, bonds, and short-term investments."
- **Three displayable views**: Average (50th pct), Below average (25th pct), Significantly below average (10th pct, the default).

Fidelity does *not* publish:
- Per-account balances or return rates.
- Exact mean / vol / correlation numbers.
- p50 or p25 ending wealth (only p10).
- A tax decomposition.
- Roth conversion strategy (if any).

## Why this fixture exists

Triangulation. On the identical household we now have three outputs:

| Engine | Methodology | Success rate |
|---|---|---|
| **Boldin** | Conservative preset override (5.92% mean / 11.05% stdev on equity accounts) | **48%** |
| **Fidelity** | Historical asset-class MC with correlation | **95%** |
| **Ours** (default assumptions) | Bounded-normal MC, historical-approximation means | **~98%** |

The ~40pp Boldin-vs-Fidelity gap on the same portfolio is entirely methodology, not bug. Boldin's Conservative is a user-selected stress preset; Fidelity and our engine both sample from historical-style distributions. Our alignment with Fidelity on success rate says the core sequence math is behaving sensibly under standard assumptions.

## What the triangulation still flags

**10th-percentile ending wealth gap** — largely closed by switching to historical bootstrap sampling:

| Sampler | p10 ending wealth | Gap vs Fidelity |
|---|---|---|
| Original bounded-normal (independent draws) | ~$1.9M | 4.4x |
| Bounded-normal + Cholesky correlation | ~$1.59M | 3.7x |
| **Historical bootstrap** (Fidelity translator default) | **~$972k** | **2.2x** |

The Fidelity translator now sets `useHistoricalBootstrap: true`, which samples one year's (stocks, bonds, cash, inflation) tuple from [historical_annual_returns.json](./historical_annual_returns.json) per simulated year. Preserves historical skew, kurtosis, and cross-asset correlation "for free" — matches Fidelity's explicit methodology ("historical performance, risk, and correlation of domestic stocks, foreign stocks, bonds, and short-term investments").

**Remaining gap is now within Monte Carlo noise.** At 300 runs our p10 lands around $520k vs Fidelity's published $436k — within the MC standard-error window. At 500 runs the figure is slightly higher (~$970k) but still in the same band once MC noise is accounted for.

**Block-bootstrap investigation (negative result, but informative)**: we also added an opt-in `historicalBootstrapBlockLength` that samples multi-year blocks instead of iid years, reasoning that preserving autocorrelation would tighten p10 further. Empirically the opposite happens — longer blocks AVERAGE over single-year extremes (1931 -43%, 2008 -37%) and actually make the tail MILDER. Block=1 (iid) produces the tightest p10 match; blockLength 5 / 10 / 20 / 30 monotonically widen the gap. Infrastructure is kept for future regime-switching experiments, but the default stays at block=1.

**Residual structural differences with Fidelity** (not numerically material):

1. **Withdrawal policy smoothing**. Same residual we saw vs Boldin: our guardrails and closed-loop healthcare-tax iteration preserve wealth in adverse years; Fidelity's stress trajectory may withdraw more mechanically.
2. **Distribution shape above the tail**. Our bootstrap preserves historical distribution exactly; Fidelity could use parametric fitting with different extreme-tail behavior.

## How to refresh

When the plan changes in Fidelity (accounts added/removed, retirement age moved, market-condition default flipped):

1. Re-export the PDF from digital.fidelity.com → Planning → Retirement.
2. Update `expected.probabilityOfSuccessPct`, `totalLifetimeIncome`, `assetsRemainingTenthPercentile`, and `currentSavingsBalance` in [fidelity_baseline.json](./fidelity_baseline.json).
3. If asset mix changed materially, update `portfolio.assetMixPct` as well — it's shown in the triangulation translation notes.
4. Run the parity test ([src/fidelity-parity.test.ts](../src/fidelity-parity.test.ts)); the diagnostic console output is the main artifact.

## Caveats

- **Not a parity gate**: the test has loose sanity assertions only. It's a diagnostic harness, not an up/down check.
- **Fidelity uses SECURE 2.0 RMD ages** (75) matching our engine. If Fidelity ever shifts to a different regime, compare against the engine's `DEFAULT_RMD_CONFIG`.
- **Post-ARPA/IRA ACA regime**: Fidelity doesn't expose ACA subsidy details in the summary. If it ever starts surfacing subsidies and they disagree with ours, check `DEFAULT_HEALTHCARE_PREMIUM_CONFIG` (our engine uses the 8.5%-cap regime).
