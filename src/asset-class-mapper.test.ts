import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS,
  deriveAssetClassMappingAssumptionsFromAccounts,
  getAssetClassMappingMetadata,
  getHoldingExposure,
  rollupHoldingsToAssetClasses,
} from './asset-class-mapper';

describe('asset class mapper', () => {
  it('maps explicit holdings into expected asset classes', () => {
    expect(getHoldingExposure('SCHD')).toEqual({ US_EQUITY: 1, INTL_EQUITY: 0, BONDS: 0, CASH: 0 });
    expect(getHoldingExposure('VXUS')).toEqual({ US_EQUITY: 0, INTL_EQUITY: 1, BONDS: 0, CASH: 0 });
    expect(getHoldingExposure('BND')).toEqual({ US_EQUITY: 0, INTL_EQUITY: 0, BONDS: 1, CASH: 0 });
    expect(getHoldingExposure('CASH')).toEqual({ US_EQUITY: 0, INTL_EQUITY: 0, BONDS: 0, CASH: 1 });
  });

  it('maps FDLO and SCHH to explicit US equity exposure', () => {
    expect(getHoldingExposure('FDLO')).toEqual({ US_EQUITY: 1, INTL_EQUITY: 0, BONDS: 0, CASH: 0 });
    expect(getHoldingExposure('SCHH')).toEqual({ US_EQUITY: 1, INTL_EQUITY: 0, BONDS: 0, CASH: 0 });

    const metadata = getAssetClassMappingMetadata([{ FDLO: 0.5, SCHH: 0.5 }]);
    expect(metadata.unknownSymbols).not.toContain('FDLO');
    expect(metadata.unknownSymbols).not.toContain('SCHH');
  });

  it('pins TRP_2030 default allocation to published 2030 fact sheet', () => {
    expect(DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.TRP_2030.BONDS).toBeCloseTo(0.346, 2);
    expect(
      DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.TRP_2030.US_EQUITY +
        DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.TRP_2030.INTL_EQUITY,
    ).toBeCloseTo(0.622, 2);
  });

  it('uses configurable ambiguous assumptions for managed sleeves', () => {
    const trp = getHoldingExposure('TRP_2030');
    (['US_EQUITY', 'INTL_EQUITY', 'BONDS', 'CASH'] as const).forEach((k) => {
      expect(trp[k]).toBeCloseTo(DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.TRP_2030[k], 10);
    });
    const central = getHoldingExposure('CENTRAL_MANAGED');
    (['US_EQUITY', 'INTL_EQUITY', 'BONDS', 'CASH'] as const).forEach((k) => {
      expect(central[k]).toBeCloseTo(DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.CENTRAL_MANAGED[k], 10);
    });

    const custom = getHoldingExposure('TRP_2030', {
      TRP_2030: { US_EQUITY: 0.3, INTL_EQUITY: 0.1, BONDS: 0.5, CASH: 0.1 },
    });
    expect(custom).toEqual({ US_EQUITY: 0.3, INTL_EQUITY: 0.1, BONDS: 0.5, CASH: 0.1 });
  });

  it('rolls up allocations into aggregate asset class exposure', () => {
    const rolled = rollupHoldingsToAssetClasses({
      SCHD: 0.5,
      VXUS: 0.2,
      BND: 0.2,
      CASH: 0.1,
    });

    expect(rolled.US_EQUITY).toBeCloseTo(0.5);
    expect(rolled.INTL_EQUITY).toBeCloseTo(0.2);
    expect(rolled.BONDS).toBeCloseTo(0.2);
    expect(rolled.CASH).toBeCloseTo(0.1);
  });

  it('surfaces ambiguous and unknown assumptions in metadata', () => {
    const metadata = getAssetClassMappingMetadata([
      { TRP_2030: 0.5, CENTRAL_MANAGED: 0.5, XYZ_UNKNOWN: 0.1 },
    ]);

    expect(metadata.ambiguousAssumptionsUsed.map((item) => item.symbol).sort()).toEqual([
      'CENTRAL_MANAGED',
      'TRP_2030',
    ]);
    expect(metadata.unknownSymbols).toContain('XYZ_UNKNOWN');
  });

  it('derives sleeve assumptions from account allocation proxies when available', () => {
    const derived = deriveAssetClassMappingAssumptionsFromAccounts({
      pretax: {
        balance: 100,
        targetAllocation: {
          SCHD: 0.6,
          BND: 0.3,
          TRP_2030: 0.1,
        },
      },
      roth: { balance: 0, targetAllocation: {} },
      taxable: {
        balance: 100,
        targetAllocation: {
          FXAIX: 0.5,
          IEFA: 0.3,
          MUB: 0.2,
          CENTRAL_MANAGED: 0.4,
        },
      },
      cash: { balance: 0, targetAllocation: { CASH: 1 } },
    });

    expect(derived.TRP_2030.BONDS).toBeGreaterThan(0);
    expect(derived.TRP_2030.US_EQUITY).toBeGreaterThan(0);
    expect(derived.CENTRAL_MANAGED.INTL_EQUITY).toBeGreaterThan(0);
  });
});
