import { describe, it, expect } from 'vitest';
import taxScenariosFixture from '../fixtures/tax_engine_scenarios.json';
import { calculateFederalTax, type YearTaxInputs } from './tax-engine';

interface TaxExpectations {
  AGI: number;
  provisionalIncome: number;
  taxableSocialSecurity: number;
  totalTaxableIncome: number;
  ordinaryTaxableIncome: number;
  LTCGTaxableIncome: number;
  federalTax: number;
  MAGI: number;
  marginalOrdinaryBracket: number;
  marginalLTCGBracket: number;
}

interface TaxScenario {
  id: string;
  description: string;
  inputs: YearTaxInputs;
  expected: TaxExpectations;
  computationNotes: string;
}

const scenarios = (taxScenariosFixture as { scenarios: TaxScenario[] }).scenarios;

// Money fields round to 2 decimal places in the engine; allow a tiny epsilon
// for any floating-point residue we don't account for in hand-computed values.
const MONEY_EPSILON = 0.01;

describe('tax-engine canonical scenarios', () => {
  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.description}`, () => {
      const actual = calculateFederalTax(scenario.inputs);
      const expected = scenario.expected;

      expect(actual.AGI).toBeCloseTo(expected.AGI, 2);
      expect(actual.provisionalIncome).toBeCloseTo(expected.provisionalIncome, 2);
      expect(actual.taxableSocialSecurity).toBeCloseTo(
        expected.taxableSocialSecurity,
        2,
      );
      expect(actual.totalTaxableIncome).toBeCloseTo(expected.totalTaxableIncome, 2);
      expect(actual.ordinaryTaxableIncome).toBeCloseTo(
        expected.ordinaryTaxableIncome,
        2,
      );
      expect(actual.LTCGTaxableIncome).toBeCloseTo(expected.LTCGTaxableIncome, 2);
      expect(Math.abs(actual.federalTax - expected.federalTax)).toBeLessThan(
        MONEY_EPSILON,
      );
      expect(actual.MAGI).toBeCloseTo(expected.MAGI, 2);
      expect(actual.marginalOrdinaryBracket).toBe(expected.marginalOrdinaryBracket);
      expect(actual.marginalLTCGBracket).toBe(expected.marginalLTCGBracket);
    });
  }

  it('fixture has at least 15 scenarios and all ids are unique', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(15);
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
