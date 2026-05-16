# Protected Reserve Model

Last updated: 2026-05-16

## Household Contract

The household north star is the spendable budget that can be supported while
preserving a $1,000,000 protected reserve in today's dollars.

That reserve is not routine lifestyle spending. It is care-first,
legacy-if-unused:

- Purpose: `care_first_legacy_if_unused`
- Available for: `late_life_care_or_health_shocks`
- Normal lifestyle spendable: `false`
- Active planning horizon: Rob age 88 / Debbie age 91
- Active modeled final year: 2055

If late-life care or health shocks consume the reserve, that is a modeled use
of the reserve rather than a failure to honor an inheritance-only goal. If care
does not consume it, the remaining reserve can pass on as legacy.

## Relationship To Legacy Fields

`legacyTargetTodayDollars` remains as a compatibility alias because many older
engine surfaces and bequest-attainment metrics already use that name. New
decision-grade surfaces must carry `protectedReserve` beside the legacy alias.

Decision-grade packets should treat the two values as the same target amount:

- `legacyTargetTodayDollars`
- `protectedReserve.targetTodayDollars`
- `protectedReserve.legacyAliasTodayDollars`

If a packet claims faithful model completeness while only carrying the legacy
scalar, that packet is invalid for the current household contract.

## What External Calculators Validate

External calculators such as FI Calc, cFIREsim, Trinity-style rolling windows,
and Boldin-style screenshots can validate mechanics:

- return sampling and historical bootstrap behavior
- withdrawal survival rates
- rough tax/spending parity
- ending-wealth distribution sanity checks

They do not validate the full household contract because they generally do not
know that the $1M target is a care-first reserve that may be used for late-life
care and only becomes legacy if unused. Local verification must therefore check
reserve semantics across north-star budgets, monthly review packets, exports,
replay packets, UI copy, AI prompts, and scenario tests.

## Verification Commands

Run the model proof path before relying on changed outputs:

```bash
npm run verify:model:quick:strict
npm run verify:model:strict
npm run test:model:all
npm run build
```

Strict verification fails on warning output and on silent drift in the household
contract, including reserve target/purpose, north-star monthly budget, replay
packet identity, modeled final year, first-year cash outflow, p10 ending wealth,
success rate, and median ending wealth.
