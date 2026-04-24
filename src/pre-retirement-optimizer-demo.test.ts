import { describe, it, expect } from 'vitest';
import { initialSeedData } from './data';
import { buildPreRetirementOptimizerRecommendation } from './pre-retirement-optimizer';

// Demo / documentation test: prints the concrete numerical output for
// the household-in-file so a human reviewer can see what the card would
// actually show. Not a parity gate — the assertion only guards against
// the demo disappearing silently.

describe('pre-retirement optimizer — demo output for current seed', () => {
  it('prints a decision-grade card for the household in file', () => {
    const asOf = new Date('2026-04-23T00:00:00Z');
    const rec = buildPreRetirementOptimizerRecommendation(
      { seedData: initialSeedData, marginalFederalRate: 0.22 },
      asOf,
    );

    const fmt = (n: number) =>
      `$${Math.round(n).toLocaleString()}`;
    const pct = (n: number) => `${Math.round(n * 100)}%`;

    const lines: string[] = [];
    lines.push('');
    lines.push('=========================================================');
    lines.push('Pre-retirement contribution optimizer — Rob, 2026 snapshot');
    lines.push('=========================================================');
    lines.push(`Headline: ${rec.headline}`);
    lines.push(
      `Both advisories (max 401k + pre-build bridge) compatible: ${
        rec.bothRecommendationsCompatible ? 'YES' : 'NO (tradeoff required)'
      }`,
    );
    lines.push('');
    lines.push('Current shortfalls vs. contribution limits:');
    for (const shortfall of rec.shortfalls) {
      lines.push(
        `  ${shortfall.label}: ${fmt(shortfall.currentAnnualContribution)} / ${fmt(shortfall.annualLimit)} = ${pct(shortfall.shortfallPct)} funded`,
      );
      if (shortfall.shortfallAnnual > 0) {
        lines.push(
          `    shortfall $${Math.round(shortfall.shortfallAnnual).toLocaleString()}/yr  → ` +
            `~${fmt(shortfall.estimatedMarginalFederalTaxSavedPerYear)}/yr in current-year tax savings at 22%`,
        );
      }
    }
    lines.push('');
    lines.push('Bridge build-up projection:');
    lines.push(`  Gross salary:                ${fmt(rec.bridge.grossSalary)}`);
    lines.push(`  Pre-tax contributions at max: ${fmt(rec.bridge.preTaxContributionsAtMax)}`);
    lines.push(`  Federal tax (est):            ${fmt(rec.bridge.estimatedFederalTaxAtMax)}`);
    lines.push(`  FICA (est, 7.65%):            ${fmt(rec.bridge.estimatedFicaTax)}`);
    lines.push(`  Take-home:                    ${fmt(rec.bridge.estimatedTakeHomeAtMax)}`);
    lines.push(`  Lifestyle spend:              ${fmt(rec.bridge.estimatedAnnualLifestyleSpend)}`);
    lines.push(`  → annual surplus to bridge:   ${fmt(rec.bridge.estimatedAnnualSurplus)}`);
    lines.push('');
    lines.push(`Years until salary ends:        ${rec.bridge.yearsUntilSalaryEnds.toFixed(2)}`);
    lines.push(`Projected additional bridge:    ${fmt(rec.bridge.projectedBridgePotContribution)}`);
    lines.push(`Current taxable balance:        ${fmt(rec.bridge.currentTaxableBalance)}`);
    lines.push(`Projected taxable at retirement: ${fmt(rec.bridge.projectedTaxableAtRetirement)}`);
    lines.push(
      `Windfalls landing in bridge window: ${fmt(rec.bridge.bridgeWindowWindfallTotal)}` +
        (rec.bridge.bridgeWindowWindfallNames.length
          ? ` (${rec.bridge.bridgeWindowWindfallNames.join(', ')})`
          : ''),
    );
    lines.push(`Bridge years to cover:          ${rec.bridge.bridgeYearsCovered.toFixed(2)}`);
    lines.push(`Bridge target balance:          ${fmt(rec.bridge.bridgeTargetBalance)}`);
    lines.push(`Coverage gap (after windfalls): ${fmt(rec.bridge.bridgeCoverageGap)}`);
    lines.push('');
    lines.push('Action steps:');
    for (const step of rec.actionSteps) {
      lines.push(`  ${step.priority}. ${step.action}`);
      lines.push(`     IMPACT: ${step.impact}`);
    }
    lines.push('=========================================================');

    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    expect(rec.applicable).toBe(true);
    expect(rec.actionSteps.length).toBeGreaterThan(0);
  });
});
