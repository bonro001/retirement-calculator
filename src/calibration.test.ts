import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import type { MarketAssumptions, SeedData } from './types';
import { buildPathResults } from './utils';
import { getDefaultVerificationAssumptions } from './verification-harness';

/**
 * Calibration test harness — validates `buildPathResults` against
 * canonical retirement-finance literature (Trinity Study, Pfau-Kitces,
 * Bengen). Distinct from `trinity-rolling-windows.test.ts` which tests
 * `replayCohort` (a simpler deterministic engine); this file tests the
 * full Monte Carlo engine the Cockpit actually uses.
 *
 * **Calibration mode** runs synthetic, tax-neutral, feature-stripped
 * scenarios that mirror the literature exactly (Trinity didn't model
 * taxes, IRMAA, or healthcare). Comparing calibration-mode results to
 * published literature validates the simulation core.
 *
 * **Product mode** (separate test block below) runs the same scenarios
 * with full features enabled. The calibration→product delta quantifies
 * what each feature adds. Both numbers are valid; they answer different
 * questions.
 *
 * Decisions locked in Phase 0.5:
 *   1. Failure definition: Trinity convention (any year with assets ≤ 0)
 *   2. Calibration tolerance bands:
 *      - Calibration mode vs literature: ±3pp solvency, ±10% median EW
 *      - Product mode vs calibration mode: documented delta, no bound
 *      - External tools vs our plan: ±10pp solvency
 *   3. LTC inflation default: inflate from year zero (Phase 2 ships).
 *      Not relevant for calibration mode (LTC disabled).
 */

// Number of trials per scenario. 500 trades CI speed for sampling
// stability — enough for ±2pp standard error on solvency rate.
const TRIALS = 500;

// ──────────────────────────────────────────────────────────────────────
// Seed builder: synthetic Trinity-equivalent household
// ──────────────────────────────────────────────────────────────────────

interface CalibrationSeedOpts {
  startingBalance: number;
  annualSpending: number;
  vtiPct: number; // 0.6 = 60/40 stocks/bonds
  horizonYears: number;
}

/**
 * Build a tax-neutral, feature-stripped seed equivalent to Trinity Study
 * setup: single retired household, all assets in one bucket (Roth, so no
 * tax on growth or withdrawal), single allocation, fixed spending growing
 * with inflation. No SS, salary, windfalls, LTC, or healthcare costs.
 */
function buildCalibrationSeed(opts: CalibrationSeedOpts): SeedData {
  const seed: SeedData = JSON.parse(JSON.stringify(initialSeedData));

  // All assets into one Roth bucket. Roth = no tax on growth or
  // withdrawal, so this is the cleanest tax-neutral scenario.
  seed.accounts.pretax.balance = 0;
  seed.accounts.taxable.balance = 0;
  seed.accounts.cash.balance = 0;
  seed.accounts.hsa.balance = 0;
  seed.accounts.roth.balance = opts.startingBalance;
  seed.accounts.roth.targetAllocation = {
    VTI: opts.vtiPct,
    BND: 1 - opts.vtiPct,
  };

  // Spending: split monthly + annual to match seed shape; we put
  // everything in essentialMonthly so guardrails don't cut it
  // (essentials are exempt from cuts).
  seed.spending.essentialMonthly = opts.annualSpending / 12;
  seed.spending.optionalMonthly = 0;
  seed.spending.travelEarlyRetirementAnnual = 0;
  seed.spending.annualTaxesInsurance = 0;

  // Strip income — already retired, no SS, no windfalls.
  seed.income.salaryAnnual = 0;
  seed.income.salaryEndDate = '2025-01-01';
  seed.income.socialSecurity = [];
  seed.income.windfalls = [];

  // Disable LTC, healthcare, HSA strategy.
  seed.rules.ltcAssumptions.eventProbability = 0;
  seed.rules.ltcAssumptions.annualCostToday = 0;
  seed.rules.healthcarePremiums.baselineAcaPremiumAnnual = 0;
  seed.rules.healthcarePremiums.baselineMedicarePremiumAnnual = 0;
  seed.rules.hsaStrategy.enabled = false;

  // Birthdates set so household is 65 at start; horizon ends at
  // (65 + horizonYears).
  const currentYear = new Date().getUTCFullYear();
  const birthYear = currentYear - 65;
  seed.household.robBirthDate = `${birthYear}-01-01`;
  seed.household.debbieBirthDate = `${birthYear}-01-01`;

  return seed;
}

// ──────────────────────────────────────────────────────────────────────
// Test runner: runs the same scenario in both parametric and historical
// modes (and historical with multiple block lengths)
// ──────────────────────────────────────────────────────────────────────

interface RunResult {
  successRate: number;
  medianEW: number;
  p10EW: number;
}

interface FourModeResult {
  param: RunResult; // parametric (default)
  histIid: RunResult; // historical bootstrap, block=1
  histBlock5: RunResult; // historical bootstrap, block=5
}

function runScenario(
  seed: SeedData,
  horizonYears: number,
  overrides: Partial<MarketAssumptions> = {},
): RunResult {
  const robEndAge = 65 + horizonYears;
  const debbieEndAge = 65 + horizonYears;
  const assumptions: MarketAssumptions = {
    ...getDefaultVerificationAssumptions(),
    simulationRuns: TRIALS,
    robPlanningEndAge: robEndAge,
    debbiePlanningEndAge: debbieEndAge,
    ...overrides,
  };
  const [path] = buildPathResults(seed, assumptions, [], []);
  return {
    successRate: path.successRate,
    medianEW: path.medianEndingWealth,
    p10EW: path.tenthPercentileEndingWealth,
  };
}

function runFourModes(seed: SeedData, horizonYears: number): FourModeResult {
  return {
    param: runScenario(seed, horizonYears, { useHistoricalBootstrap: false }),
    histIid: runScenario(seed, horizonYears, {
      useHistoricalBootstrap: true,
      historicalBootstrapBlockLength: 1,
    }),
    histBlock5: runScenario(seed, horizonYears, {
      useHistoricalBootstrap: true,
      historicalBootstrapBlockLength: 5,
    }),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Calibration mode tests — validate engine math against literature
// ──────────────────────────────────────────────────────────────────────

describe('Calibration mode — engine vs Trinity / Pfau-Kitces literature', () => {
  // Tolerance bands per Phase 0.5 decision #3:
  //   - Calibration mode vs literature: ±3pp solvency, ±10% median EW
  // Implemented as floor assertions (≥X) since Trinity quotes a single
  // headline; we check that we land in or above the published band.

  it('Trinity 4% / 60-40 / 30y / historical iid: ~95% solvent ±3pp', () => {
    const seed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 40_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const { histIid } = runFourModes(seed, 30);
    // Trinity Study (Cooley/Hubbard/Walz 1998): 95-100% on this config
    expect(histIid.successRate).toBeGreaterThanOrEqual(0.92);
    expect(histIid.successRate).toBeLessThanOrEqual(1.0);
  }, 60_000);

  it('Trinity 4% / 60-40 / 30y / historical block(5): ~92% solvent ±3pp', () => {
    const seed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 40_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const { histBlock5 } = runFourModes(seed, 30);
    // Block bootstrap with 5-year blocks averages over multi-year
    // crisis-recovery cycles; tends to slightly raise p10 vs iid but
    // shouldn't dramatically shift solvency on 4% rule.
    expect(histBlock5.successRate).toBeGreaterThanOrEqual(0.89);
  }, 60_000);

  it('Trinity 4% / 60-40 / 30y / parametric: 70-80% (DOCUMENTED — equityMean=0.074 conservatism)', () => {
    // PHASE 2.1 RESOLUTION (2026-04-29): root cause identified.
    //
    // Parametric mode lands ~73-78% vs Pfau-Kitces 85-92%. Sensitivity
    // analysis showed bumping equityMean 0.074 → 0.10 closes the gap.
    // Bumping to 0.12 (Trinity historical nominal) overshoots to ~88%.
    //
    // The engine math is correct. equityMean: 0.074 is a deliberately
    // conservative forward-looking assumption — historical real equity
    // is ~7%, our default produces ~4.6% real after subtracting 2.8%
    // inflation drag. This is a defensible "future returns will be
    // lower than past" stance, not a bug.
    //
    // Sensitivity sweep results (5% / 60-40 / 30y, calibration mode):
    //   eq=0.074 baseline:        50.8%  (current default)
    //   eq=0.085:                  62.8%  (+12pp)
    //   eq=0.10 (~historical real): 75.4%  (+24.6pp)
    //   eq=0.12 (Trinity nominal): 88.2%  (+37.4pp)
    //   useCorrelatedReturns=true: 50.6%  (no effect — sampling
    //                                       correlation is NOT a driver)
    //
    // This test captures current parametric-mode behavior under the
    // conservative assumption as a regression baseline. The gap to
    // Pfau-Kitces is intentional and documented.
    //
    // See CALIBRATION_WORKPLAN.md "External validation" section.
    const seed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 40_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const { param } = runFourModes(seed, 30);
    expect(param.successRate).toBeGreaterThanOrEqual(0.70);
    expect(param.successRate).toBeLessThanOrEqual(0.82);
  }, 60_000);

  it('Trinity 5% / 60-40 / 30y / parametric: 30-55% (DOCUMENTED — same equityMean conservatism)', () => {
    // PHASE 2.1 RESOLUTION (2026-04-29): same root cause as 4% scenario.
    //
    // 5% withdrawal against ~4.6% effective real return from
    // equityMean=0.074 is unsustainable in expectation. Solvency
    // ~36-50% reflects this correctly. With historical assumptions
    // (eq=0.10), solvency rises to ~75% — within the literature band
    // (60-70% per Pfau-Kitces parametric estimates).
    //
    // This is consistent with Trinity Study's published 5% rule
    // results: 70-80% with HISTORICAL nominal returns. Our parametric
    // default produces lower number because of the conservative
    // equityMean choice. Engine is correct; assumption is conservative.
    const seed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 50_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const { param } = runFourModes(seed, 30);
    expect(param.successRate).toBeGreaterThanOrEqual(0.30);
    expect(param.successRate).toBeLessThanOrEqual(0.55);
  }, 60_000);

  it('Phase 2.1 ROOT CAUSE: bumping equityMean 0.074 → 0.10 closes the parametric gap', () => {
    // Locks in the diagnosis as a regression test. If a future engine
    // change causes the gap-with-equityMean=0.10 to NOT match published
    // literature, that's a real bug. As long as bumping the parameter
    // closes the gap, we know the simulation core is sound and the
    // headline gap is purely an assumption-choice.
    const seed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 50_000,  // 5% withdrawal — biggest gap
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const baseline = runScenario(seed, 30, { useHistoricalBootstrap: false });
    const withHistoricalEquity = runScenario(seed, 30, {
      useHistoricalBootstrap: false,
      equityMean: 0.10,
      internationalEquityMean: 0.10,
    });
    // Bumping equity 0.074 → 0.10 should add ≥15pp solvency on the
    // 5% scenario. If this assertion ever fails, the simulation core
    // has changed in a way that breaks the diagnosis.
    expect(withHistoricalEquity.successRate - baseline.successRate)
      .toBeGreaterThanOrEqual(0.15);
    // And the historical-equity result should land in or above the
    // literature band (60-70% per Pfau-Kitces).
    expect(withHistoricalEquity.successRate).toBeGreaterThanOrEqual(0.65);
  }, 90_000);

  it('Trinity 5% / 60-40 / 30y / historical iid + block(5): block must be no worse than iid', () => {
    // Probe whether iid sampling produces unrealistically bad sequences
    // on high-withdrawal scenarios. Block bootstrap preserves multi-year
    // correlation (1929-1932, 2000-2002 stay clustered) and should
    // produce equal or higher solvency on stress scenarios.
    //
    // If iid is producing artificial worst-cases, block(5) will be
    // visibly higher. Per Phase 1.2 hypothesis testing.
    const seed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 50_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const { histIid, histBlock5 } = runFourModes(seed, 30);
    // Trinity Study: 5% / 60-40 / 30y → 70-80% historical
    // We accept either iid or block hitting that band; whichever does,
    // the other should be within 5pp.
    expect(Math.max(histIid.successRate, histBlock5.successRate))
      .toBeGreaterThanOrEqual(0.65);
    // Block should never be DRAMATICALLY worse than iid — if it is,
    // the bootstrap mechanism has a bug.
    expect(histBlock5.successRate).toBeGreaterThanOrEqual(histIid.successRate - 0.05);
  }, 90_000);

  it('Trinity 3% / 60-40 / 30y / historical iid: 99%+ solvent (well below sustainable draw)', () => {
    // 3% withdrawal is universally agreed safe. Any engine that fails
    // here has a fundamental bug.
    const seed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 30_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const { histIid } = runFourModes(seed, 30);
    expect(histIid.successRate).toBeGreaterThanOrEqual(0.97);
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────
// Distribution-shape tests — make sure we're not just hitting the
// solvency target while distorting the distribution shape
// ──────────────────────────────────────────────────────────────────────

describe('Distribution shape — median EW and P10 sanity checks', () => {
  it('Trinity 4% / 60-40 / 30y / historical iid: median EW > $500k', () => {
    // With 4% rule and ~9% real historical equity returns, median
    // surviving trial accumulates substantial wealth. Sanity floor.
    const seed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 40_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const { histIid } = runFourModes(seed, 30);
    expect(histIid.medianEW).toBeGreaterThan(500_000);
  }, 60_000);

  it('Trinity 4% / 60-40 / 30y / historical iid: P10 EW >= $0', () => {
    // P10 includes failed trials (≤ $0). Just sanity-check the
    // percentile is non-negative; specific value tested below.
    const seed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 40_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const { histIid } = runFourModes(seed, 30);
    expect(histIid.p10EW).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('Block bootstrap raises P10 vs iid on stress scenario (5% withdrawal)', () => {
    // Mirrors block-bootstrap.test.ts hypothesis but specifically for
    // a high-withdrawal scenario where iid sequences can produce
    // pathological tails.
    const seed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 50_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const { histIid, histBlock5 } = runFourModes(seed, 30);
    // Block(5) should have a fatter (less negative) left tail.
    expect(histBlock5.p10EW).toBeGreaterThanOrEqual(histIid.p10EW);
  }, 90_000);
});

// ──────────────────────────────────────────────────────────────────────
// Product mode vs calibration mode — quantify the "feature tax"
// (taxes, IRMAA, healthcare, RMDs etc.) introduced when running the
// same scenario through full product features.
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a product-mode equivalent of the calibration seed: same
 * starting balance, spending, and allocation, but with assets in
 * pretax (subjects to ordinary tax + RMDs at 73), healthcare costs
 * enabled. This isolates the "feature delta" from pure simulation math.
 */
function buildProductModeSeed(opts: CalibrationSeedOpts): SeedData {
  const seed = buildCalibrationSeed(opts);
  // Move balance from Roth to pretax — exposes ordinary tax + RMDs.
  seed.accounts.roth.balance = 0;
  seed.accounts.pretax.balance = opts.startingBalance;
  seed.accounts.pretax.targetAllocation = {
    VTI: opts.vtiPct,
    BND: 1 - opts.vtiPct,
  };
  // Re-enable healthcare premiums (ages 65+, so Medicare).
  seed.rules.healthcarePremiums.baselineMedicarePremiumAnnual = 2220;
  return seed;
}

describe('Product mode vs calibration mode — feature tax measurement', () => {
  it('Trinity 4% / 60-40 / 30y / historical iid: product-mode delta ≤ 15pp', () => {
    // Product mode adds federal tax on pretax withdrawals + RMDs +
    // Medicare premiums + IRMAA tier proximity. Each chips away at
    // solvency. We expect a 5-15pp drop vs calibration mode; if the
    // delta is much larger, there's an unexpected interaction worth
    // investigating.
    const calibSeed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 40_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const productSeed = buildProductModeSeed({
      startingBalance: 1_000_000,
      annualSpending: 40_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const calib = runScenario(calibSeed, 30, { useHistoricalBootstrap: true });
    const product = runScenario(productSeed, 30, { useHistoricalBootstrap: true });
    const delta = calib.successRate - product.successRate;
    expect(delta).toBeGreaterThanOrEqual(0); // product can't be BETTER
    expect(delta).toBeLessThanOrEqual(0.15); // 15pp ceiling
  }, 90_000);
});

// ──────────────────────────────────────────────────────────────────────
// Determinism — engine should produce the same answer for the same seed
// ──────────────────────────────────────────────────────────────────────

describe('Determinism', () => {
  it('Calibration scenario is deterministic across runs (same seed)', () => {
    const seed = buildCalibrationSeed({
      startingBalance: 1_000_000,
      annualSpending: 40_000,
      vtiPct: 0.6,
      horizonYears: 30,
    });
    const a = runScenario(seed, 30, { useHistoricalBootstrap: true });
    const b = runScenario(seed, 30, { useHistoricalBootstrap: true });
    expect(a.successRate).toBe(b.successRate);
    expect(a.medianEW).toBe(b.medianEW);
    expect(a.p10EW).toBe(b.p10EW);
  }, 60_000);
});
