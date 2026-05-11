/**
 * Die-With-Zero adoption-payload builder (Phase 2 MVP — annual flow only).
 *
 * Three exports:
 *   - `buildAnnualAdoptionPayload` — produces a paste-ready payload for
 *     the annual recurring adoption flow (no goals patch; assumes first-time
 *     adoption has already set the legacy target in seed-data.json).
 *   - `validateAdoptionPayload` — runtime schema check before pasting.
 *   - `formatPayloadForClipboard` — pretty-printed valid JSON (no comments;
 *     seed-data.json is imported as JSON at src/data.ts:1 and comments
 *     would break the build).
 *
 * First-time and commitment flows are deferred; see DIE_WITH_ZERO_WORKPLAN.md
 * Phase 3 for their specs.
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

export interface AdoptionPayload {
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
): AdoptionPayload {
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
 * Catches:
 * - Empty `scheduledOutflows`
 * - Events with `year !== currentYear` (annual flow allows only current-year events)
 * - Negative amounts
 * - Unknown `sourceAccount` (HSA intentionally excluded)
 * - $38K joint annual exclusion overflow on `annual_exclusion_cash` events
 *   that aren't tagged `taxTreatment: 'requires_form_709'`
 * - Required fields missing or wrong type
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
    if (meta['flow'] !== 'annual') {
      errors.push(
        `meta.flow: expected 'annual', got ${JSON.stringify(meta['flow'])}`,
      );
    }
    if (typeof meta['currentYear'] !== 'number' || !Number.isInteger(meta['currentYear'])) {
      errors.push('meta.currentYear: must be an integer year');
    }
    if (typeof meta['payloadDescription'] !== 'string') {
      errors.push('meta.payloadDescription: must be a string');
    }
  }

  // ── scheduledOutflows ────────────────────────────────────────────────────
  if (!Array.isArray(p['scheduledOutflows'])) {
    errors.push('scheduledOutflows: must be an array');
    return { valid: errors.length === 0, errors };
  }

  const outflows = p['scheduledOutflows'] as unknown[];

  if (outflows.length === 0) {
    errors.push(
      'scheduledOutflows: annual payload must contain at least one event (use a skip-year note if intentional)',
    );
  }

  // currentYear from meta (may be absent if meta validation failed above)
  const currentYear =
    typeof p['meta'] === 'object' &&
    p['meta'] !== null &&
    typeof (p['meta'] as Record<string, unknown>)['currentYear'] === 'number'
      ? (p['meta'] as Record<string, unknown>)['currentYear'] as number
      : null;

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
