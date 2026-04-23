export type AssetClass = 'US_EQUITY' | 'INTL_EQUITY' | 'BONDS' | 'CASH';
import type { AccountsData } from './types';

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

const AMBIGUOUS_SYMBOLS = new Set(['TRP_2030', 'CENTRAL_MANAGED']);

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
  // Industry-standard glide path for a 2030-target fund at roughly 4 years
  // out (c. 2025-2026). T. Rowe Price's own 2030 retirement-date fund
  // composition sits close to this mix: ~55% total equity (65/35 US/INTL)
  // with ~45% fixed-income + cash as it approaches target.
  TRP_2030: normalizeExposure({
    US_EQUITY: 0.3,
    INTL_EQUITY: 0.2,
    BONDS: 0.45,
    CASH: 0.05,
  }),
  // Fidelity "central managed" positions — user-managed, true composition
  // not published to the API. Default to a balanced 50/50 equity/bond
  // blend with US bias typical of conservative balanced portfolios.
  CENTRAL_MANAGED: normalizeExposure({
    US_EQUITY: 0.4,
    INTL_EQUITY: 0.15,
    BONDS: 0.35,
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

function resolveKnownExposure(
  symbol: string,
): Required<AssetClassExposure> | null {
  const normalizedSymbol = symbol.toUpperCase();
  const mapping = EXPLICIT_HOLDING_MAP[normalizedSymbol];
  if (!mapping) {
    return null;
  }
  return normalizeExposure(mapping);
}

function deriveProxyExposureFromAllocation(
  allocation: Record<string, number>,
) {
  const totals = { US_EQUITY: 0, INTL_EQUITY: 0, BONDS: 0, CASH: 0 };
  let knownWeight = 0;

  Object.entries(allocation).forEach(([symbol, weight]) => {
    const normalizedSymbol = symbol.toUpperCase();
    if (AMBIGUOUS_SYMBOLS.has(normalizedSymbol) || weight <= 0) {
      return;
    }
    const knownExposure = resolveKnownExposure(normalizedSymbol);
    if (!knownExposure) {
      return;
    }
    totals.US_EQUITY += weight * knownExposure.US_EQUITY;
    totals.INTL_EQUITY += weight * knownExposure.INTL_EQUITY;
    totals.BONDS += weight * knownExposure.BONDS;
    totals.CASH += weight * knownExposure.CASH;
    knownWeight += weight;
  });

  if (knownWeight <= 0) {
    return null;
  }

  return normalizeExposure(totals);
}

export function deriveAssetClassMappingAssumptionsFromAccounts(
  accounts: AccountsData,
  configured?: AssetClassMappingAssumptions,
): Required<AssetClassMappingAssumptions> {
  // TRP_2030 is a public target-date fund. Its glide path is determined
  // by the fund manager, not by the user's self-directed holdings. Using
  // bucket-derivation here (as earlier versions did) skews the TRP_2030
  // proxy toward whatever US/bond mix the user happens to hold in the
  // same bucket, which is not predictive. Prefer the published-default
  // glide-path composition unless the caller passed an explicit override.
  const trpProxy = configured?.TRP_2030 ?? DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.TRP_2030;

  // CENTRAL_MANAGED is genuinely user-dependent (brokerage-managed portfolio).
  // Derive from the bucket's other holdings as a best-available guess and
  // fall back to a balanced default when the bucket has no known holdings.
  const centralManagedProxy =
    configured?.CENTRAL_MANAGED ??
    deriveProxyExposureFromAllocation(accounts.taxable.targetAllocation) ??
    deriveProxyExposureFromAllocation(accounts.roth.targetAllocation) ??
    DEFAULT_AMBIGUOUS_HOLDING_ASSUMPTIONS.CENTRAL_MANAGED;

  return {
    TRP_2030: normalizeExposure(trpProxy),
    CENTRAL_MANAGED: normalizeExposure(centralManagedProxy),
  };
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
        assumptions?.TRP_2030
          ? 'Target-date 2030 mapped using configured account-level assumption.'
          : 'Target-date 2030 approximated as blended allocation from exported model defaults.',
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
        assumptions?.CENTRAL_MANAGED
          ? 'Managed sleeve mapped using configured account-level assumption.'
          : 'Managed sleeve approximated as balanced risk mix from exported model defaults.',
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
