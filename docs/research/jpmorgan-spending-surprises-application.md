# J.P. Morgan Retirement Spending Surprises - Model Application

Source captured locally:

- `docs/research/jpmorgan-three-new-spending-surprises-2025.pdf`
- Public landing page: https://am.jpmorgan.com/us/en/asset-management/adv/insights/retirement-insights/three-spending-surprises/
- Current Guide to Retirement spending curve:
  https://am.jpmorgan.com/content/dam/jpm-am-aem/global/en/insights/retirement-insights/guide-to-retirement-us.pdf
- Spending-smile equation:
  https://www.financialplanningassociation.org/sites/default/files/2020-05/1%20Exploring%20the%20Retirement%20Consumption%20Puzzle.pdf

## Research Signals To Model

1. Retiree spending follows an age-shaped reported curve rather than a simple
   exponential decline. The default adapter normalizes the Guide to Retirement
   $250k-$750k retired-household age buckets to the age-65 anchor:
   60=$77,060, 65=$70,900, 70=$67,640, 75=$62,460, 80=$57,650,
   85=$55,000, 90=$54,000, 95=$53,980. Pre-65 retired years now use
   the higher 60-64 bucket rather than being clamped to age 65.

2. The public J.P. Morgan age buckets flatten at the oldest ages rather than
   publishing a household-specific late-life coefficient. The adapter uses
   Blanchett's published retirement-spending-smile equation from age 90 onward
   so the curve can dip and then turn upward in a deterministic, sourced way.

3. Retiree spending inflation can run below broad inflation for non-healthcare
   categories. The adapter keeps the one-percentage-point gap as an explicit
   sensitivity layer over the reported age curve rather than using it as the
   curve itself.

4. Spending can surge around retirement, especially when labor income is still
   material and retirement-income cash flow begins. The adapter keeps this out
   of the base case and exposes it as a named sensitivity.

5. Temporary spending volatility is common. The adapter models this as
   deterministic +20% sensitivity schedules rather than adding a new random
   spending shock to the Monte Carlo engine.

6. Paid-off-home carrying costs should stay visible. The adapter keeps
   `annualTaxesInsurance` flat in real terms by default instead of letting it
   fade with lifestyle spending.

7. Normal current travel is part of the J.P. Morgan age-65 curve anchor. It is
   not added as a separate overlay in the base J.P. Morgan row; only explicit
   above-normal travel is modeled as an extra overlay.

## Engine Mapping

Implementation lives in `src/jpmorgan-spending-surprises.ts`.

The adapter returns:

- `modelCompleteness`
- `inferredAssumptions`
- `annualSpendScheduleByYear`
- per-year intermediate calculations
- base and perturbed scenarios

The schedule can be passed directly into the existing engine option:

```ts
buildPathResults(data, assumptions, [], [], {
  pathMode: 'selected_only',
  annualSpendScheduleByYear: scenario.annualSpendScheduleByYear,
});
```

The base J.P. Morgan schedule is intentionally marked `reconstructed` because
the public research gives aggregate spending behavior rather than a full
household-specific coefficient table.
