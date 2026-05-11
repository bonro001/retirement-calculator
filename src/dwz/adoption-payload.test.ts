/**
 * Adoption-payload tests (DwZ Phase 2 MVP).
 *
 * Tests cover:
 *  1. Builder produces correct shape with meta.flow === 'annual'
 *  2. Builder accepts an empty outflows array (no crash)
 *  3. Validator rejects empty scheduledOutflows
 *  4. Validator rejects event with year !== currentYear
 *  5. Validator rejects negative amount
 *  6. Validator rejects unknown sourceAccount (including 'hsa')
 *  7. Validator rejects $50K cash annual_exclusion_cash without requires_form_709
 *  8. formatPayloadForClipboard returns parseable JSON
 */

import { describe, it, expect } from 'vitest';
import {
  buildAnnualAdoptionPayload,
  buildFirstTimeAdoptionPayload,
  validateAdoptionPayload,
  formatPayloadForClipboard,
  type AdoptionPayload,
  type FirstTimeAdoptionPayload,
} from './adoption-payload';
import type { ScheduledOutflow } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CURRENT_YEAR = 2026;

function makeOutflow(overrides: Partial<ScheduledOutflow> = {}): ScheduledOutflow {
  return {
    name: 'ethan_annual_2026',
    year: CURRENT_YEAR,
    amount: 10_000,
    sourceAccount: 'cash',
    recipient: 'ethan',
    vehicle: 'annual_exclusion_cash',
    label: 'Ethan cash gift 2026',
    taxTreatment: 'gift_no_tax_consequence',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildAnnualAdoptionPayload', () => {
  it('produces correct shape with meta.flow === annual and currentYear populated', () => {
    const outflows = [makeOutflow()];
    const payload = buildAnnualAdoptionPayload(outflows, CURRENT_YEAR);

    expect(payload.meta.flow).toBe('annual');
    expect(payload.meta.currentYear).toBe(CURRENT_YEAR);
    expect(payload.meta.dwzVersion).toBe('dwz-mvp-v1');
    expect(typeof payload.meta.generatedAt).toBe('string');
    expect(typeof payload.meta.payloadDescription).toBe('string');
    expect(payload.scheduledOutflows).toHaveLength(1);
    expect(payload.scheduledOutflows[0]).toEqual(outflows[0]);
  });

  it('accepts an empty outflows array without throwing', () => {
    // Builder should not throw on empty input — it produces a valid
    // (though semantically unusual) payload. The validator catches the
    // semantic problem; the builder stays a pure data constructor.
    expect(() => buildAnnualAdoptionPayload([], CURRENT_YEAR)).not.toThrow();
    const payload = buildAnnualAdoptionPayload([], CURRENT_YEAR);
    expect(payload.scheduledOutflows).toHaveLength(0);
    expect(payload.meta.flow).toBe('annual');
  });
});

describe('validateAdoptionPayload', () => {
  it('accepts a well-formed annual payload', () => {
    const payload = buildAnnualAdoptionPayload([makeOutflow()], CURRENT_YEAR);
    const result = validateAdoptionPayload(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects empty scheduledOutflows', () => {
    const payload = buildAnnualAdoptionPayload([], CURRENT_YEAR);
    const result = validateAdoptionPayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('scheduledoutflows'))).toBe(true);
  });

  it('rejects an event with year !== currentYear', () => {
    const futureOutflow = makeOutflow({ year: CURRENT_YEAR + 3 });
    const payload = buildAnnualAdoptionPayload([futureOutflow], CURRENT_YEAR);
    const result = validateAdoptionPayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('annual flow only allows currentYear'))).toBe(true);
  });

  it('rejects a negative amount', () => {
    const negativeOutflow = makeOutflow({ amount: -500 });
    const payload = buildAnnualAdoptionPayload([negativeOutflow], CURRENT_YEAR);
    const result = validateAdoptionPayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('non-negative'))).toBe(true);
  });

  it('rejects unknown sourceAccount including hsa', () => {
    // 'hsa' is intentionally excluded per Phase 0 schema + IRS Pub 969
    const badOutflow = makeOutflow({
      sourceAccount: 'hsa' as ScheduledOutflow['sourceAccount'],
    });
    const payload = buildAnnualAdoptionPayload([badOutflow], CURRENT_YEAR);
    const result = validateAdoptionPayload(payload);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('hsa'))).toBe(true);
  });

  it('rejects $50K cash annual_exclusion_cash gift without requires_form_709 tag', () => {
    // $50K > $38K joint annual exclusion — must be tagged requires_form_709
    const bigGift = makeOutflow({
      amount: 50_000,
      vehicle: 'annual_exclusion_cash',
      taxTreatment: 'gift_no_tax_consequence',
    });
    const payload = buildAnnualAdoptionPayload([bigGift], CURRENT_YEAR);
    const result = validateAdoptionPayload(payload);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes('annual exclusion') || e.includes('requires_form_709'),
      ),
    ).toBe(true);
  });

  it('accepts $50K annual_exclusion_cash with requires_form_709 tag', () => {
    const bigGiftTagged = makeOutflow({
      amount: 50_000,
      vehicle: 'annual_exclusion_cash',
      taxTreatment: 'requires_form_709',
    });
    const payload = buildAnnualAdoptionPayload([bigGiftTagged], CURRENT_YEAR);
    const result = validateAdoptionPayload(payload);
    expect(result.valid).toBe(true);
  });
});

describe('formatPayloadForClipboard', () => {
  it('returns valid JSON parseable by JSON.parse', () => {
    const payload = buildAnnualAdoptionPayload([makeOutflow()], CURRENT_YEAR);
    const formatted = formatPayloadForClipboard(payload);
    expect(() => JSON.parse(formatted)).not.toThrow();
    const parsed = JSON.parse(formatted) as AdoptionPayload;
    expect(parsed.meta.flow).toBe('annual');
    expect(parsed.scheduledOutflows).toHaveLength(1);
  });

  it('produces pretty-printed JSON (indented, not a one-liner)', () => {
    const payload = buildAnnualAdoptionPayload([makeOutflow()], CURRENT_YEAR);
    const formatted = formatPayloadForClipboard(payload);
    // Pretty-printed JSON has newlines.
    expect(formatted.includes('\n')).toBe(true);
  });
});

// ── Phase 3 tests: first_time flow ────────────────────────────────────────────

describe('buildFirstTimeAdoptionPayload', () => {
  it('produces correct shape: flow tag + goals block + outflows', () => {
    const outflows = [makeOutflow()];
    const payload = buildFirstTimeAdoptionPayload(outflows, CURRENT_YEAR, 200_000);

    expect(payload.meta.flow).toBe('first_time');
    expect(payload.meta.currentYear).toBe(CURRENT_YEAR);
    expect(payload.meta.dwzVersion).toBe('dwz-mvp-v1');
    expect(typeof payload.meta.generatedAt).toBe('string');
    expect(typeof payload.meta.payloadDescription).toBe('string');
    expect(payload.goals.legacyTargetTodayDollars).toBe(200_000);
    expect(payload.scheduledOutflows).toHaveLength(1);
    expect(payload.scheduledOutflows[0]).toEqual(outflows[0]);
  });

  it('accepts empty outflows array (target-only adoption is valid)', () => {
    expect(() => buildFirstTimeAdoptionPayload([], CURRENT_YEAR, 500_000)).not.toThrow();
    const payload = buildFirstTimeAdoptionPayload([], CURRENT_YEAR, 500_000);
    expect(payload.scheduledOutflows).toHaveLength(0);
    expect(payload.meta.flow).toBe('first_time');
    expect(payload.goals.legacyTargetTodayDollars).toBe(500_000);
  });

  it('accepts zero legacy target (Aggressive scenario)', () => {
    const payload = buildFirstTimeAdoptionPayload([], CURRENT_YEAR, 0);
    expect(payload.goals.legacyTargetTodayDollars).toBe(0);
  });
});

describe('validateAdoptionPayload — first_time flow', () => {
  it('accepts a well-formed first_time payload with outflows', () => {
    const payload = buildFirstTimeAdoptionPayload([makeOutflow()], CURRENT_YEAR, 200_000);
    const result = validateAdoptionPayload(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a well-formed first_time payload with empty outflows (target-only)', () => {
    const payload = buildFirstTimeAdoptionPayload([], CURRENT_YEAR, 500_000);
    const result = validateAdoptionPayload(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects first_time payload missing goals', () => {
    const payload = buildFirstTimeAdoptionPayload([], CURRENT_YEAR, 200_000);
    // Manually strip the goals block
    const bad = { ...payload } as Record<string, unknown>;
    delete bad['goals'];
    const result = validateAdoptionPayload(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('goals'))).toBe(true);
  });

  it('rejects first_time payload with negative legacyTargetTodayDollars', () => {
    const payload = buildFirstTimeAdoptionPayload([], CURRENT_YEAR, 200_000);
    const bad = {
      ...payload,
      goals: { legacyTargetTodayDollars: -50_000 },
    };
    const result = validateAdoptionPayload(bad);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('non-negative') || e.includes('legacyTargetTodayDollars')),
    ).toBe(true);
  });

  it('rejects annual payload that includes a goals block', () => {
    const annualPayload = buildAnnualAdoptionPayload([makeOutflow()], CURRENT_YEAR);
    // Inject a goals block into an annual payload
    const bad = {
      ...annualPayload,
      goals: { legacyTargetTodayDollars: 200_000 },
    };
    const result = validateAdoptionPayload(bad);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('annual payload must NOT include a goals block')),
    ).toBe(true);
  });
});

describe('formatPayloadForClipboard — first_time flow', () => {
  it('round-trips a first_time payload through JSON.parse correctly', () => {
    const payload = buildFirstTimeAdoptionPayload([makeOutflow()], CURRENT_YEAR, 200_000);
    const formatted = formatPayloadForClipboard(payload);
    expect(() => JSON.parse(formatted)).not.toThrow();
    const parsed = JSON.parse(formatted) as FirstTimeAdoptionPayload;
    expect(parsed.meta.flow).toBe('first_time');
    expect(parsed.goals.legacyTargetTodayDollars).toBe(200_000);
    expect(parsed.scheduledOutflows).toHaveLength(1);
    // Pretty-printed
    expect(formatted.includes('\n')).toBe(true);
  });
});
