import type {
  SixPackInstrument,
  SixPackInstrumentId,
  SixPackSnapshot,
  SixPackStatus,
} from './six-pack-types';

export interface HomeAssistantSixPackPayload {
  state: SixPackStatus;
  attributes: {
    summary: string;
    as_of: string;
    green: number;
    amber: number;
    red: number;
    unknown: number;
    action_required: boolean;
    pucks: Record<SixPackInstrumentId, SixPackStatus>;
  };
}

export interface HomeAssistantSixPackInstrumentPayload {
  state: SixPackStatus;
  attributes: {
    id: SixPackInstrumentId;
    label: string;
    headline: string;
    trend: SixPackInstrument['trend'];
    front_metric: string | null;
    reason: string;
    rule: string;
    updated_at: string;
    stale: boolean;
  };
}

export interface HomeAssistantSixPackPanelPayload {
  state: SixPackStatus;
  attributes: {
    summary: string;
    as_of: string;
    action_required: boolean;
    green: number;
    amber: number;
    red: number;
    unknown: number;
    pucks: Array<{
      id: SixPackInstrumentId;
      order: number;
      label: string;
      question: string;
      status: SixPackStatus;
      color: 'green' | 'yellow' | 'red' | 'gray';
      headline: string;
      trend: SixPackInstrument['trend'];
      trend_symbol: string;
      front_metric: string | null;
      stale: boolean;
      updated_at: string;
      reason: string;
    }>;
  };
}

const statusColor: Record<SixPackStatus, 'green' | 'yellow' | 'red' | 'gray'> = {
  green: 'green',
  amber: 'yellow',
  red: 'red',
  unknown: 'gray',
};

const trendSymbol: Record<SixPackInstrument['trend'], string> = {
  up: '↑',
  down: '↓',
  flat: '→',
  none: '',
};

export function buildHomeAssistantSixPackPayload(
  snapshot: SixPackSnapshot,
): HomeAssistantSixPackPayload {
  return {
    state: snapshot.overallStatus,
    attributes: {
      summary: snapshot.summary,
      as_of: snapshot.asOfIso,
      green: snapshot.counts.green,
      amber: snapshot.counts.amber,
      red: snapshot.counts.red,
      unknown: snapshot.counts.unknown,
      action_required: snapshot.actionRequired,
      pucks: Object.fromEntries(
        snapshot.instruments.map((instrument) => [instrument.id, instrument.status]),
      ) as Record<SixPackInstrumentId, SixPackStatus>,
    },
  };
}

export function buildHomeAssistantSixPackPanelPayload(
  snapshot: SixPackSnapshot,
): HomeAssistantSixPackPanelPayload {
  return {
    state: snapshot.overallStatus,
    attributes: {
      summary: snapshot.summary,
      as_of: snapshot.asOfIso,
      action_required: snapshot.actionRequired,
      green: snapshot.counts.green,
      amber: snapshot.counts.amber,
      red: snapshot.counts.red,
      unknown: snapshot.counts.unknown,
      pucks: snapshot.instruments.map((instrument, index) => ({
        id: instrument.id,
        order: index + 1,
        label: instrument.label,
        question: instrument.question,
        status: instrument.status,
        color: statusColor[instrument.status],
        headline: instrument.headline,
        trend: instrument.trend,
        trend_symbol: trendSymbol[instrument.trend],
        front_metric: instrument.frontMetric ?? null,
        stale: instrument.sourceFreshness.stale,
        updated_at: instrument.sourceFreshness.asOfIso ?? snapshot.asOfIso,
        reason: instrument.reason,
      })),
    },
  };
}

export function buildHomeAssistantSixPackInstrumentPayload(
  instrument: SixPackInstrument,
  snapshotAsOfIso: string,
): HomeAssistantSixPackInstrumentPayload {
  return {
    state: instrument.status,
    attributes: {
      id: instrument.id,
      label: instrument.label,
      headline: instrument.headline,
      trend: instrument.trend,
      front_metric: instrument.frontMetric ?? null,
      reason: instrument.reason,
      rule: instrument.rule,
      updated_at: instrument.sourceFreshness.asOfIso ?? snapshotAsOfIso,
      stale: instrument.sourceFreshness.stale,
    },
  };
}
