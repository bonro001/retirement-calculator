export type SixPackStatus = 'green' | 'amber' | 'red' | 'unknown';
export type SixPackTrend = 'up' | 'down' | 'flat' | 'none';

export type SixPackInstrumentId =
  | 'lifestyle_pace'
  | 'cash_runway'
  | 'portfolio_weather'
  | 'plan_integrity'
  | 'tax_cliffs'
  | 'watch_items';

export interface SixPackSourceFreshness {
  asOfIso: string | null;
  label: string;
  stale: boolean;
}

export interface SixPackInstrument {
  id: SixPackInstrumentId;
  label: string;
  question: string;
  status: SixPackStatus;
  trend: SixPackTrend;
  headline: string;
  frontMetric?: string;
  reason: string;
  rule: string;
  detail: string;
  actionLabel?: string;
  sourceFreshness: SixPackSourceFreshness;
  diagnostics: Record<string, number | string | boolean | null>;
}

export interface SixPackSnapshot {
  version: 'six_pack_v1';
  asOfIso: string;
  overallStatus: SixPackStatus;
  summary: string;
  counts: Record<SixPackStatus, number>;
  actionRequired: boolean;
  instruments: SixPackInstrument[];
}
