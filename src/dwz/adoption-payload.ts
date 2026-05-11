/**
 * Die-With-Zero adoption-payload builder (Phase 3 MVP — annual + first_time flows).
 *
 * Exports:
 *   - `buildAnnualAdoptionPayload` — produces a paste-ready payload for
 *     the annual recurring adoption flow (no goals patch; assumes first-time
 *     adoption has already set the legacy target in seed-data.json).
 *   - `buildFirstTimeAdoptionPayload` — produces a payload that sets the
 *     legacy target in seed-data.json (goals patch) and optionally includes
 *     outflows for the current year.
 *   - `validateAdoptionPayload` — flow-aware runtime schema check before pasting.
 *   - `formatPayloadForClipboard` — pretty-printed valid JSON (no comments;
 *     seed-data.json is imported as JSON at src/data.ts:1 and comments
 *     would break the build).
 */

import type { ScheduledOutflow } from '../types';

// ── IRS 2026 constants ────────────────────────────────────────────────────────

/**
 * Annual gift-tax exclusion per donor per donee (IRS 2026).
 * Joint Rob + Debbie = 2 × $19K = $38K per recipient per year.
 */
const ANNUAL_EXCLUSION_PER_DONOR = 19_000;
const JOINT_ANNUAL_EXCLUSION = ANNUAL_EXCLUSION_PER_DONOR * 2; // $38,000

// ── Payload type ─────────────────────────────────────────────────────────────

/**
 * Annual flow payload — only current-year events, no goals patch.
 * Use after first-time adoption has already set the legacy target.
 */
export interface AnnualAdoptionPayload {
  meta: {
    /** ISO timestamp when the payload was generated. */
    generatedAt: string;
    /** DwZ schema version tag. */
    dwzVersion: 'dwz-mvp-v1';
    /** Annual flow — only current-year events, no goals patch. */
    flow: 'annual';
    /** Calendar year the events belong to. */
    currentYear: number;
    /** Human-readable description shown in the DwZScreen UI. NOT in the JSON
     *  pasted into seed-data.json — it lives here so the screen can display it
     *  to the user without having to re-parse the payload. */
    payloadDescription: string;
  };
  /** Events to APPEND to the existing top-level `scheduledOutflows` array. */
  scheduledOutflows: ScheduledOutflow[];
}

/**
 * First-time flow payload — sets the legacy target (goals patch) and
 * optionally includes outflows for the current year.
 * Paste once to commit to a DwZ target; merge the `goals` object into
 * seed-data.json (don't replace — preserve other goals fields).
 */
export interface FirstTimeAdoptionPayload {
  meta: {
    /** ISO timestamp when the payload was generated. */
    generatedAt: string;
    /** DwZ schema version tag. */
    dwzVersion: 'dwz-mvp-v1';
    /** First-time flow — includes goals patch. */
    flow: 'first_time';
    /** Calendar year this payload was generated for. */
    currentYear: number;
    /** Human-readable description shown in the DwZScreen UI. */
    payloadDescription: string;
  };
  /**
   * Goals patch — merge into `goals` in seed-data.json.
   * Do NOT replace the entire `goals` object; preserve other fields.
   */
  goals: {
    /** Legacy bequest target in today's dollars. */
    legacyTargetTodayDollars: number;
  };
  /** Optional events to APPEND to `scheduledOutflows`. May be empty. */
  scheduledOutflows: ScheduledOutflow[];
}

/** Discriminated union of both payload shapes. */
export type AdoptionPayload = AnnualAdoptionPayload | FirstTimeAdoptionPayload;

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build an annual-flow adoption payload for the provided outflows.
 *
 * Assumptions:
 * - All events belong to `currentYear` (caller is responsible for
 *   supplying only current-year events; the validator will catch violations).
 * - No goals patch is included — the legacy target should already be set
 *   in seed-data.json from a prior first-time adoption.
 *
 * @param outflows  ScheduledOutflow entries to include in the payload.
 * @param currentYear  Calendar year (e.g. 2026). Used in `meta.currentYear`
 *                     and in the auto-generated description.
 */
export function buildAnnualAdoptionPayload(
  outflows: ScheduledOutflow[],
  currentYear: number,
): AnnualAdoptionPayload {
  const totalAmount = outflows.reduce((sum, o) => sum + o.amount, 0);
  const recipientList = [...new Set(outflows.map((o) => o.recipient))].join(
    ', ',
  );
  const recipientPart = recipientList
    ? ` to ${recipientList}`
    : '';
  const payloadDescription =
    outflows.length === 0
      ? `DwZ annual payload for ${currentYear} — no gifts (skipped year)`
      : `DwZ annual payload for ${currentYear}: $${totalAmount.toLocaleString()}${recipientPart}`;

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      dwzVersion: 'dwz-mvp-v1',
      flow: 'annual',
      currentYear,
      payloadDescription,
    },
    scheduledOutflows: outflows,
  };
}

/**
 * Build a first-time adoption payload that sets the legacy target and
 * optionally includes outflows for the current year.
 *
 * This payload must be pasted **once** to commit to a DwZ target.
 * Merge only the `goals` object into seed-data.json — do not replace
 * any other top-level keys. After saving, re-mine for the new ranking
 * gate to take effect.
 *
 * @param outflows  ScheduledOutflow entries to include (may be empty
 *                  for a target-only adoption — gifts can be added later
 *                  via the annual flow).
 * @param currentYear  Calendar year (e.g. 2026).
 * @param legacyTargetTodayDollars  The new legacy bequest target in
 *                                  today's dollars (must be non-negative).
 */
export function buildFirstTimeAdoptionPayload(
  outflows: ScheduledOutflow[],
  currentYear: number,
  legacyTargetTodayDollars: number,
): FirstTimeAdoptionPayload {
  const targetFmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(legacyTargetTodayDollars);

  const giftPart =
    outflows.length === 0
      ? 'no gifts this year'
      : (() => {
          const total = outflows.reduce((sum, o) => sum + o.amount, 0);
          const recipients = [...new Set(outflows.map((o) => o.recipient))].join(', ');
          const totalFmt = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: 0,
          }).format(total);
          return `$${total.toLocaleString()} to ${recipients} (total ${totalFmt})`;
        })();

  const payloadDescription =
    `DwZ first-time adoption for ${currentYear}: target ${targetFmt} — ${giftPart}`;

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      dwzVersion: 'dwz-mvp-v1',
      flow: 'first_time',
      currentYear,
      payloadDescription,
    },
    goals: {
      legacyTargetTodayDollars,
    },
    scheduledOutflows: outflows,
  };
}

// ── Validator ─────────────────────────────────────────────────────────────────

const VALID_SOURCE_ACCOUNTS = new Set<string>([
  'cash',
  'taxable',
  'pretax',
  'roth',
]);

const VALID_VEHICLES = new Set<string>([
  'annual_exclusion_cash',
  '529_superfund',
  'direct_pay_tuition_medical',
  'utma',
  'other',
]);

const VALID_TAX_TREATMENTS = new Set<string>([
  'gift_no_tax_consequence',
  'requires_form_709',
]);

/**
 * Validate an adoption payload before the household pastes it into
 * seed-data.json. Returns `{ valid: true, errors: [] }` on success, or
 * `{ valid: false, errors: [...] }` with human-readable error descriptions.
 *
 * Flow-aware rules:
 * - `annual` payload MUST NOT include a `goals` block; MUST contain at least
 *   one outflow (use a skip-year note entry if intentionally skipping).
 * - `first_time` payload MUST include a `goals.legacyTargetTodayDollars`
 *   (non-negative number); outflows may be empty (target-only adoption is valid).
 *
 * Common outflow rules (both flows):
 * - Events with `year !== currentYear` are rejected (annual + first_time both
 *   target current-year events; future-year commitments are a separate flow).
 * - Negative amounts are rejected.
 * - Unknown `sourceAccount` (HSA intentionally excluded).
 * - $38K joint annual exclusion overflow on `annual_exclusion_cash` events
 *   that aren't tagged `taxTreatment: 'requires_form_709'`.
 */
export function validateAdoptionPayload(payload: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (typeof payload !== 'object' || payload === null) {
    return { valid: false, errors: ['Payload must be a non-null object'] };
  }

  const p = payload as Record<string, unknown>;

  // ── meta ──────────────────────────────────────────────────────────────────
  let flow: string | null = null;
  let currentYear: number | null = null;

  if (typeof p['meta'] !== 'object' || p['meta'] === null) {
    errors.push('meta: must be an object');
  } else {
    const meta = p['meta'] as Record<string, unknown>;

    if (typeof meta['generatedAt'] !== 'string') {
      errors.push('meta.generatedAt: must be a string (ISO timestamp)');
    }
    if (meta['dwzVersion'] !== 'dwz-mvp-v1') {
      errors.push(
        `meta.dwzVersion: expected 'dwz-mvp-v1', got ${JSON.stringify(meta['dwzVersion'])}`,
      );
    }
    if (meta['flow'] !== 'annual' && meta['flow'] !== 'first_time') {
      errors.push(
        `meta.flow: expected 'annual' or 'first_time', got ${JSON.stringify(meta['flow'])}`,
      );
    } else {
      flow = meta['flow'] as string;
    }
    if (typeof meta['currentYear'] !== 'number' || !Number.isInteger(meta['currentYear'])) {
      errors.push('meta.currentYear: must be an integer year');
    } else {
      currentYear = meta['currentYear'] as number;
    }
    if (typeof meta['payloadDescription'] !== 'string') {
      errors.push('meta.payloadDescription: must be a string');
    }
  }

  // ── Flow-specific rules ───────────────────────────────────────────────────

  if (flow === 'first_time') {
    // first_time MUST have goals.legacyTargetTodayDollars
    if (typeof p['goals'] !== 'object' || p['goals'] === null) {
      errors.push(
        'goals: first_time payload must include a goals object with legacyTargetTodayDollars',
      );
    } else {
      const goals = p['goals'] as Record<string, unknown>;
      if (typeof goals['legacyTargetTodayDollars'] !== 'number') {
        errors.push(
          'goals.legacyTargetTodayDollars: must be a number (today dollars)',
        );
      } else if ((goals['legacyTargetTodayDollars'] as number) < 0) {
        errors.push(
          `goals.legacyTargetTodayDollars: must be non-negative, got ${goals['legacyTargetTodayDollars']}`,
        );
      }
    }
  } else if (flow === 'annual') {
    // annual MUST NOT have goals
    if ('goals' in p && p['goals'] !== undefined) {
      errors.push(
        'goals: annual payload must NOT include a goals block. Goals are set once via the first_time flow.',
      );
    }
  }

  // ── scheduledOutflows ────────────────────────────────────────────────────
  if (!Array.isArray(p['scheduledOutflows'])) {
    errors.push('scheduledOutflows: must be an array');
    return { valid: errors.length === 0, errors };
  }

  const outflows = p['scheduledOutflows'] as unknown[];

  // annual flow requires at least one outflow; first_time allows empty
  if (flow === 'annual' && outflows.length === 0) {
    errors.push(
      'scheduledOutflows: annual payload must contain at least one event (use a skip-year note if intentional)',
    );
  }

  // Per-recipient annual_exclusion_cash running totals for the $38K cap check.
  const annualExclusionTotals = new Map<string, number>();

  outflows.forEach((outflow, idx) => {
    const label = `scheduledOutflows[${idx}]`;

    if (typeof outflow !== 'object' || outflow === null) {
      errors.push(`${label}: must be an object`);
      return;
    }

    const o = outflow as Record<string, unknown>;

    // Required string fields
    if (typeof o['name'] !== 'string' || o['name'].trim() === '') {
      errors.push(`${label}.name: must be a non-empty string`);
    }
    if (typeof o['recipient'] !== 'string' || o['recipient'].trim() === '') {
      errors.push(`${label}.recipient: must be a non-empty string`);
    }
    if (typeof o['label'] !== 'string') {
      errors.push(`${label}.label: must be a string`);
    }

    // year
    if (typeof o['year'] !== 'number' || !Number.isInteger(o['year'])) {
      errors.push(`${label}.year: must be an integer`);
    } else if (currentYear !== null && o['year'] !== currentYear) {
      errors.push(
        `${label}.year: annual flow only allows currentYear (${currentYear}) events, got ${o['year']}. Use the commitment flow for future-year events.`,
      );
    }

    // amount
    if (typeof o['amount'] !== 'number') {
      errors.push(`${label}.amount: must be a number`);
    } else if (o['amount'] < 0) {
      errors.push(`${label}.amount: must be non-negative, got ${o['amount']}`);
    }

    // sourceAccount — HSA excluded
    if (typeof o['sourceAccount'] !== 'string') {
      errors.push(`${label}.sourceAccount: must be a string`);
    } else if (!VALID_SOURCE_ACCOUNTS.has(o['sourceAccount'])) {
      const got = o['sourceAccount'];
      const note =
        got === 'hsa'
          ? ' (HSA is intentionally excluded as a gift source — non-qualified HSA distributions are ordinary income + 20% penalty pre-65 per IRS Pub 969)'
          : '';
      errors.push(
        `${label}.sourceAccount: unknown account '${got}'${note}. Valid: cash | taxable | pretax | roth`,
      );
    }

    // vehicle
    if (typeof o['vehicle'] !== 'string') {
      errors.push(`${label}.vehicle: must be a string`);
    } else if (!VALID_VEHICLES.has(o['vehicle'])) {
      errors.push(
        `${label}.vehicle: unknown vehicle '${o['vehicle']}'. Valid: annual_exclusion_cash | 529_superfund | direct_pay_tuition_medical | utma | other`,
      );
    }

    // taxTreatment
    if (typeof o['taxTreatment'] !== 'string') {
      errors.push(`${label}.taxTreatment: must be a string`);
    } else if (!VALID_TAX_TREATMENTS.has(o['taxTreatment'])) {
      errors.push(
        `${label}.taxTreatment: unknown value '${o['taxTreatment']}'. Valid: gift_no_tax_consequence | requires_form_709`,
      );
    }

    // $38K joint annual exclusion overflow check for annual_exclusion_cash
    if (
      o['vehicle'] === 'annual_exclusion_cash' &&
      typeof o['amount'] === 'number' &&
      typeof o['recipient'] === 'string' &&
      o['taxTreatment'] !== 'requires_form_709'
    ) {
      const recipient = o['recipient'] as string;
      const prev = annualExclusionTotals.get(recipient) ?? 0;
      const next = prev + (o['amount'] as number);
      annualExclusionTotals.set(recipient, next);
      if (next > JOINT_ANNUAL_EXCLUSION) {
        errors.push(
          `${label}: annual_exclusion_cash gifts to '${recipient}' total $${next.toLocaleString()} which exceeds the $${JOINT_ANNUAL_EXCLUSION.toLocaleString()} joint annual exclusion. Tag excess events with taxTreatment: 'requires_form_709' (IRS Form 709 tracks lifetime exemption usage even when no tax is owed).`,
        );
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

// ── Clipboard formatter ───────────────────────────────────────────────────────

/**
 * Format a payload as pretty-printed, valid JSON ready to paste into
 * seed-data.json.
 *
 * IMPORTANT: No comments. seed-data.json is imported via
 * `import seedData from '../seed-data.json'` at src/data.ts:1 — JSON
 * comments (JSONC) break the build. Paste instructions live in the
 * DwZScreen UI, not in this output.
 *
 * The household appends the `scheduledOutflows` entries to the existing
 * top-level `scheduledOutflows` array in seed-data.json (or creates the
 * array if it doesn't exist yet).
 */
export function formatPayloadForClipboard(payload: AdoptionPayload): string {
  return JSON.stringify(payload, null, 2);
}
