import { describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { defaultAssumptions } from './default-assumptions';
import { buildLifeModelAudit } from './life-model-audit';
import type { SeedData } from './types';

const generatedAtIso = '2026-05-14T00:00:00.000Z';

function cloneSeed(data: SeedData): SeedData {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

describe('life model audit', () => {
  it('surfaces explicit cash-in destination and current-mix investment policy', () => {
    const audit = buildLifeModelAudit({
      data: initialSeedData,
      assumptions: defaultAssumptions,
      generatedAtIso,
    });

    const inheritance = audit.events.find((event) => event.id === 'cash_in_inheritance');
    expect(inheritance).toBeTruthy();
    expect(inheritance?.steps.find((step) => step.id === 'destination')).toMatchObject({
      status: 'explicit',
      evidence: expect.arrayContaining([
        'destinationAccount=taxable',
        'trackingMode=taxable_shadow_sleeve',
        'assumptionSource=user_confirmed_invest_unspent_windfall_and_home_sale_cash_in_current_portfolio_mix',
      ]),
    });
    expect(inheritance?.steps.find((step) => step.id === 'investment_policy')).toMatchObject({
      status: 'explicit',
      evidence: expect.arrayContaining([
        'investmentPolicy=current_portfolio_mix',
      ]),
    });
  });

  it('marks material cash-ins as life-model watch items when deployment is only inferred', () => {
    const data = cloneSeed(initialSeedData);
    data.rules.windfallDeploymentPolicy = undefined;

    const audit = buildLifeModelAudit({
      data,
      assumptions: defaultAssumptions,
      generatedAtIso,
    });

    const inheritance = audit.events.find((event) => event.id === 'cash_in_inheritance');
    expect(inheritance).toMatchObject({
      reviewStatus: 'watch',
      materiality: 'high',
    });
    expect(inheritance?.steps.find((step) => step.id === 'destination')).toMatchObject({
      status: 'inferred',
      evidence: expect.arrayContaining([
        'assumptionSource=inferred_engine_default',
      ]),
    });
    expect(audit.modelCompleteness).toBe('reconstructed');
    expect(audit.materialUnresolvedEventCount).toBeGreaterThan(0);
  });
});
