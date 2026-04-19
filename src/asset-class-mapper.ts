export type AssetClass = 'US_EQUITY' | 'INTL_EQUITY' | 'BONDS' | 'CASH';

export interface AssetClassExposure {
  US_EQUITY?: number;
  INTL_EQUITY?: number;
  BONDS?: number;
  CASH?: number;
}

export interface AmbiguousHoldingAssumption {
  symbol: 'TRP_2030' | 'CENTRAL_MANAGED';
  exposure: Required<AssetClassExposure>;
  description: string;
}

export interface AssetClassMappingAssumptions {
  TRP_2030?: Required<AssetClassExposure>;
  CENTRAL_MANAGED?: Required<AssetClassExposure>;
}

export interface AssetClassMappingMetadata {
  ambiguousAssumptionsUsed: AmbiguousHoldingAssumption[];
  unknownSymbols: string[];
}

const normalizeExposure = (exposure: AssetClassExposure): Required<AssetClassExposure> => {
  const next = {
    US_EQUITY: Math.max(0, exposure.US_EQUITY ?? 0),
    INTL_EQUITY: Math.max(0, exposure.INTL_EQUITY ?? 0),
    BONDS: Math.max(0, exposure.BONDS ?? 0),
    CASH: Math.max(0, exposure.CASH ?? 0),
  };
  const total = next.US_EQUITY + next.INTL_EQUITY + next.BONDS + next.CASH;
  if (total <= 0) {
    return { US_EQUITY: 1, INTL_EQUITY: 0, BONDS: 0, CASH: 0 };
  }
  return {
    US_EQUITY: next.US_EQUITY / total,
    INTL_EQUITY: next.INTL_EQUITY / total,
    BONDS: next.BONDS / total,
    CASH: next.CASH / total,
  };
};

export const DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS: Required<AssetClassMappingAssumptions> = {
  TRP_2030: normalizeExposure({
    US_EQUITY: 0.45,
    INTL_EQUITY: 0.15,
    BONDS: 0.35,
    CASH: 0.05,
  }),
  CENTRAL_MANAGED: normalizeExposure({
    US_EQUITY: 0.5,
    INTL_EQUITY: 0.15,
    BONDS: 0.25,
    CASH: 0.1,
  }),
};

const EXPLICIT_HOLDING_MAP: Record<string, AssetClassExposure> = {
  SCHD: { US_EQUITY: 1 },
  BND: { BONDS: 1 },
  VTI: { US_EQUITY: 1 },
  VXUS: { INTL_EQUITY: 1 },
  FCNTX: { US_EQUITY: 1 },
  FXAIX: { US_EQUITY: 1 },
  IEFA: { INTL_EQUITY: 1 },
  FDGRX: { US_EQUITY: 1 },
  IJH: { US_EQUITY: 1 },
  IEMG: { INTL_EQUITY: 1 },
  MUB: { BONDS: 1 },
  FLO: { US_EQUITY: 1 },
  CASH: { CASH: 1 },
  FELV: { US_EQUITY: 1 },
  HAIN: { US_EQUITY: 1 },
  FAGIX: { BONDS: 1 },
  FSRIX: { BONDS: 1 },
};

export function getHoldingExposure(
  symbol: string,
  assumptions?: AssetClassMappingAssumptions,
): Required<AssetClassExposure> {
  const normalizedSymbol = symbol.toUpperCase();
  if (normalizedSymbol === 'TRP_2030') {
    return normalizeExposure(assumptions?.TRP_2030 ?? DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.TRP_2030);
  }
  if (normalizedSymbol === 'CENTRAL_MANAGED') {
    return normalizeExposure(
      assumptions?.CENTRAL_MANAGED ?? DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.CENTRAL_MANAGED,
    );
  }
  if (EXPLICIT_HOLDING_MAP[normalizedSymbol]) {
    return normalizeExposure(EXPLICIT_HOLDING_MAP[normalizedSymbol]);
  }
  return normalizeExposure({ US_EQUITY: 1 });
}

export function rollupHoldingsToAssetClasses(
  allocation: Record<string, number>,
  assumptions?: AssetClassMappingAssumptions,
) {
  return Object.entries(allocation).reduce(
    (totals, [symbol, weight]) => {
      const exposure = getHoldingExposure(symbol, assumptions);
      totals.US_EQUITY += weight * exposure.US_EQUITY;
      totals.INTL_EQUITY += weight * exposure.INTL_EQUITY;
      totals.BONDS += weight * exposure.BONDS;
      totals.CASH += weight * exposure.CASH;
      return totals;
    },
    { US_EQUITY: 0, INTL_EQUITY: 0, BONDS: 0, CASH: 0 } as Required<AssetClassExposure>,
  );
}

export function getAssetClassMappingMetadata(
  allocations: Array<Record<string, number>>,
  assumptions?: AssetClassMappingAssumptions,
): AssetClassMappingMetadata {
  const ambiguousAssumptionsUsed: AmbiguousHoldingAssumption[] = [];
  const seen = new Set<string>();
  const symbols = allocations.flatMap((allocation) => Object.keys(allocation).map((key) => key.toUpperCase()));
  const uniqueSymbols = [...new Set(symbols)];

  if (uniqueSymbols.includes('TRP_2030')) {
    const exposure = normalizeExposure(
      assumptions?.TRP_2030 ?? DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.TRP_2030,
    );
    ambiguousAssumptionsUsed.push({
      symbol: 'TRP_2030',
      exposure,
      description:
        'Target-date 2030 approximated as blended allocation from exported model defaults.',
    });
    seen.add('TRP_2030');
  }

  if (uniqueSymbols.includes('CENTRAL_MANAGED')) {
    const exposure = normalizeExposure(
      assumptions?.CENTRAL_MANAGED ?? DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.CENTRAL_MANAGED,
    );
    ambiguousAssumptionsUsed.push({
      symbol: 'CENTRAL_MANAGED',
      exposure,
      description:
        'Managed sleeve approximated as balanced risk mix from exported model defaults.',
    });
    seen.add('CENTRAL_MANAGED');
  }

  const unknownSymbols = uniqueSymbols.filter(
    (symbol) => !EXPLICIT_HOLDING_MAP[symbol] && !seen.has(symbol),
  );

  return {
    ambiguousAssumptionsUsed,
    unknownSymbols,
  };
}
