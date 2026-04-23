# Property invariants

Rules that must hold for any valid retirement plan evaluated by our engine. Each invariant is encoded as a test; violations are guaranteed bugs (sign flips, accounting errors, or withdrawal-policy regressions).

Tests live in:
- [src/property-monotonicity.test.ts](../src/property-monotonicity.test.ts) — "one-sided" invariants (perturbation should only move the metric one way).
- [src/property-dominance.test.ts](../src/property-dominance.test.ts) — "strict" invariants (one plan strictly dominates another).
- Harness: [src/property-harness.ts](../src/property-harness.ts).

All tests run with a fixed Monte Carlo seed and a low simulation-run count so perturbations produce deterministic deltas.

## Monotonicity invariants (one-sided)

| # | Invariant | Perturbation | Metric direction |
|---|-----------|--------------|------------------|
| M1 | More spending can never increase success | Double `optionalMonthly` | `successRate` does not increase |
| M2 | Less spending can never reduce success | Halve `essentialMonthly` | `successRate` does not decrease |
| M3 | Delaying retirement cannot reduce success | Push `salaryEndDate` forward 2 years | `successRate` does not decrease |
| M4 | A windfall cannot reduce ending wealth | Add a $500k non-taxable windfall in year 2 | `medianEndingWealth` does not decrease |
| M5 | Larger starting cash cannot reduce ending wealth | Add $200k to cash bucket | `medianEndingWealth` does not decrease |
| M6 | Smaller starting cash cannot increase ending wealth | Halve cash balance | `medianEndingWealth` does not increase |

## Strict-dominance invariants

| # | Invariant | Perturbation | Metric direction |
|---|-----------|--------------|------------------|
| D1 | Strictly better equity returns → strictly higher ending wealth | `equityMean += 0.02` | `medianEndingWealth` strictly higher |
| D2 | Strictly lower inflation → strictly higher ending wealth | `inflation -= 0.01` | `medianEndingWealth` strictly higher |
| D3 | Doubling pretax balance → ending wealth at least ≥ baseline | Double `accounts.pretax.balance` | `medianEndingWealth` at least equal |
| D4 | Strictly better bond returns → strictly higher ending wealth | `bondMean += 0.02` | `medianEndingWealth` strictly higher |

## Non-invariants (deliberately excluded)

These would look like invariants but aren't strictly true for our engine:

- **Claiming SS earlier → lower success.** Depends on market sequence; earlier SS reduces sequence risk exposure, which can raise success in adverse scenarios. Not a strict invariant.
- **Higher market vol → lower median ending wealth.** For lognormal returns, median is depressed by vol drag; for normal returns, the mean is unchanged. Depends on distribution.
- **Longer planning horizon → lower success.** More years = more risk exposure, but also more potential compounding and SS stream; can go either way.
- **More Roth conversion → higher ending wealth.** Depends on future vs current tax rate assumptions. Plan-specific.

## Running

```
npm test -- src/property-monotonicity.test.ts src/property-dominance.test.ts
```

Both suites use a fixed seed (424242) at low simulation runs (30) to keep wall time manageable while preserving determinism.
