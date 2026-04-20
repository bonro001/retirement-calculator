# Flight Path Threshold Calibration

Last calibrated: April 20, 2026  
Threshold profile version: `2026-04-20`  
Review date: July 20, 2026

## Calibration approach

Thresholds in `src/flight-path-policy.ts` are calibrated against a deterministic scenario suite
(`src/flight-path-policy-thresholds.test.ts`) so recommendations are actionable without noisy
micro-alerts.

## Scenario suite outcomes used for tuning

1. Spend-gap recommendation is suppressed for small deltas and turns on only for material deltas.
2. Cash runway recommendations appear only when cash is outside the calibrated runway band.
3. IRMAA recommendation appears when MAGI headroom is near/below pressure threshold.
4. Roth conversion recommendation appears only when conversion room is non-trivial.
5. Withdrawal concentration recommendation appears only when one source is materially dominant.

## Active tuned thresholds

- `spendGapTriggerMonthly = 200`
- `recommendedCashBufferMonths = 18`
- `cashBufferLowerBoundRatio = 0.92`
- `cashBufferUpperBoundRatio = 1.5`
- `irmaaHeadroomPressureDollars = 8000`
- `irmaaUrgentHeadroomDollars = 3000`
- `plannedConversionSuggestionMinimumAnnual = 2500`
- `withdrawalConcentrationRatio = 0.65`
- `effectSignalNormalization.successRateDelta = 0.025`
- `effectSignalNormalization.supportedMonthlyDelta = 350`
- `effectSignalNormalization.yearsFundedDelta = 1.5`
- `sensitivityDirection.supportedMonthlyDeltaFloor = 40`
- `sensitivityDirection.signTolerance = 0.08`
- `confidenceScoreThresholds.high = 0.7`
- `confidenceScoreThresholds.medium = 0.42`

## Rationale summary

- Raise spend-gap trigger to avoid churn on small monthly differences that are within normal
  simulation noise.
- Tighten the cash upper-band trigger to catch obvious cash drag earlier.
- Lower IRMAA pressure trigger from 10k to 8k headroom so recommendations fire closer to where
  surcharge risk becomes operationally relevant.
- Raise conversion suggestion minimum to avoid low-impact conversion guidance.
- Raise withdrawal concentration threshold to prioritize meaningful concentration risk.
