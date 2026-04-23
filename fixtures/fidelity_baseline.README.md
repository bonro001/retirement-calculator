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

**10th-percentile ending wealth gap**. Fidelity publishes $436k at p10; our engine's `tenthPercentileEndingWealth` lands around $1.9M. That's a 4x gap on the stress endpoint, and it survives matching Fidelity's methodology roughly. Likely contributors, none individually confirmed:

1. **Correlation**. Fidelity explicitly models cross-asset correlation; our `boundedNormal` samples each asset class independently. Uncorrelated samples produce less extreme joint drawdowns than correlated ones.
2. **Bounded-normal clipping**. Our equity returns are clipped at ±45%; realized history includes -37% (2008) and -43% (1931) — inside bounds — but rare multi-year drawdowns accumulate differently in a clipped normal than in historical sequences.
3. **Withdrawal policy smoothing**. Same residual we saw vs Boldin: our guardrails and closed-loop healthcare-tax iteration preserve wealth in adverse years. Fidelity's "significantly below average" trajectory likely withdraws more mechanically.
4. **Per-year distribution shape**. Historical is left-skewed and kurtotic; our normal draws are symmetric.

Not urgent to fix — the success rate is the headline number and it's close. But if we're building a decision tool where users read "my p10 outcome is $X," that number drifts from Fidelity's by a factor of 4 and deserves a resolution path before it's surfaced prominently.

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
