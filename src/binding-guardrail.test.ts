import { describe, expect, it } from 'vitest';
import { determineBindingGuardrailFromProbe } from './spend-solver';

function makeEval(input: {
  successRate: number;
  legacy: number;
  tax: number;
  healthcare: number;
  irmaaRate: number;
  acaCost: number;
  annualSpend?: number;
}) {
  return {
    annualSpend: input.annualSpend ?? 120_000,
    successRate: input.successRate,
    projectedLegacyTodayDollars: input.legacy,
    annualFederalTaxEstimate: input.tax,
    annualHealthcareCostEstimate: input.healthcare,
    pathResult: {
      irmaaExposureRate: input.irmaaRate,
      yearlySeries: [
        {
          robAge: 62,
          debbieAge: 63,
          medianNetAcaCost: input.acaCost,
        },
      ],
    },
  } as any;
}

describe('binding guardrail selection', () => {
  it('picks success floor when spending increase breaches success first', () => {
    const baseline = makeEval({
      successRate: 0.84,
      legacy: 1_100_000,
      tax: 20_000,
      healthcare: 9_000,
      irmaaRate: 0.08,
      acaCost: 7_000,
    });
    const probe = makeEval({
      successRate: 0.74,
      legacy: 1_050_000,
      tax: 23_000,
      healthcare: 10_000,
      irmaaRate: 0.1,
      acaCost: 7_200,
      annualSpend: 126_000,
    });
    const result = determineBindingGuardrailFromProbe({
      baseline,
      probe,
      constraints: {
        minSuccessRate: 0.8,
        legacyFloorTodayDollars: 1_000_000,
        legacyTargetTodayDollars: 1_000_000,
        legacyTargetBandLowerTodayDollars: 1_000_000,
        legacyTargetBandUpperTodayDollars: 1_050_000,
      },
      floorAnnual: 60_000,
      ceilingAnnual: 220_000,
      recommendedAnnualSpend: 120_000,
      toleranceAnnual: 250,
      retainHouse: false,
      inheritanceEnabled: true,
      allocationLocked: false,
    });
    expect(result.bindingGuardrail).toBe('success_floor');
    expect(result.bindingGuardrailExplanation.length).toBeGreaterThan(0);
  });

  it('picks legacy target when spending increase breaches legacy first', () => {
    const baseline = makeEval({
      successRate: 0.86,
      legacy: 1_050_000,
      tax: 20_000,
      healthcare: 9_000,
      irmaaRate: 0.08,
      acaCost: 7_000,
    });
    const probe = makeEval({
      successRate: 0.82,
      legacy: 930_000,
      tax: 22_000,
      healthcare: 10_000,
      irmaaRate: 0.1,
      acaCost: 7_300,
      annualSpend: 125_000,
    });
    const result = determineBindingGuardrailFromProbe({
      baseline,
      probe,
      constraints: {
        minSuccessRate: 0.8,
        legacyFloorTodayDollars: 1_000_000,
        legacyTargetTodayDollars: 1_000_000,
        legacyTargetBandLowerTodayDollars: 1_000_000,
        legacyTargetBandUpperTodayDollars: 1_050_000,
      },
      floorAnnual: 60_000,
      ceilingAnnual: 220_000,
      recommendedAnnualSpend: 120_000,
      toleranceAnnual: 250,
      retainHouse: false,
      inheritanceEnabled: true,
      allocationLocked: false,
    });
    expect(result.bindingGuardrail).toBe('legacy_target');
  });

  it('changes guardrail category when probe impacts differ', () => {
    const baseline = makeEval({
      successRate: 0.88,
      legacy: 1_200_000,
      tax: 18_000,
      healthcare: 8_500,
      irmaaRate: 0.05,
      acaCost: 6_500,
    });
    const successProbe = makeEval({
      successRate: 0.76,
      legacy: 1_150_000,
      tax: 19_000,
      healthcare: 8_900,
      irmaaRate: 0.06,
      acaCost: 6_700,
      annualSpend: 125_000,
    });
    const acaProbe = makeEval({
      successRate: 0.84,
      legacy: 1_120_000,
      tax: 20_500,
      healthcare: 10_500,
      irmaaRate: 0.06,
      acaCost: 12_000,
      annualSpend: 125_000,
    });

    const successBound = determineBindingGuardrailFromProbe({
      baseline,
      probe: successProbe,
      constraints: {
        minSuccessRate: 0.8,
        legacyFloorTodayDollars: 1_000_000,
        legacyTargetTodayDollars: 1_000_000,
        legacyTargetBandLowerTodayDollars: 1_000_000,
        legacyTargetBandUpperTodayDollars: 1_050_000,
      },
      floorAnnual: 60_000,
      ceilingAnnual: 220_000,
      recommendedAnnualSpend: 120_000,
      toleranceAnnual: 250,
      retainHouse: false,
      inheritanceEnabled: true,
      allocationLocked: false,
    });
    const acaBound = determineBindingGuardrailFromProbe({
      baseline,
      probe: acaProbe,
      constraints: {
        minSuccessRate: 0.8,
        legacyFloorTodayDollars: 1_000_000,
        legacyTargetTodayDollars: 1_000_000,
        legacyTargetBandLowerTodayDollars: 1_000_000,
        legacyTargetBandUpperTodayDollars: 1_050_000,
      },
      floorAnnual: 60_000,
      ceilingAnnual: 220_000,
      recommendedAnnualSpend: 120_000,
      toleranceAnnual: 250,
      retainHouse: false,
      inheritanceEnabled: true,
      allocationLocked: false,
    });

    expect(successBound.bindingGuardrail).toBe('success_floor');
    expect(acaBound.bindingGuardrail).toBe('ACA_affordability');
  });
});
