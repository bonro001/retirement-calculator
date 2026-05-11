/**
 * DwZScreen — Die-With-Zero what-if panel (Phase 2 MVP).
 *
 * A single what-if surface. The user enters a gift (recipient, year, amount,
 * source account, vehicle), sees the simulated impact on their end amount in
 * real-time, and can copy an adoption payload to paste into seed-data.json.
 *
 * Phase 2 scope:
 *   - Preset gift sizes + custom amount
 *   - Simulator-driven impact display (calls simulateGift twice)
 *   - Copy-payload button (annual flow only)
 *
 * Deferred to later phases (not built here):
 *   - Tournament view / multi-strategy comparison
 *   - Trajectory forecast
 *   - Schedule builder / "this year's recommended gift" auto-fill
 *   - Long-horizon commitments / 529 superfund opt-in
 *   - Survivor stress checks
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from './store';
import { useClusterSession } from './useClusterSession';
import { useRecommendedPolicy } from './use-recommended-policy';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import { POLICY_MINER_ENGINE_VERSION } from './policy-miner-types';
import { POLICY_MINING_TRIAL_COUNT } from './policy-mining-config';
import { DEFAULT_LEGACY_TARGET_TODAY_DOLLARS } from './legacy-target-cache';
import { simulateGift } from './dwz/what-if-simulator';
import {
  buildAnnualAdoptionPayload,
  formatPayloadForClipboard,
} from './dwz/adoption-payload';
import type { EvalContext } from './dwz/types';
import type { ScheduledOutflow } from './types';

// ── Preset gift sizes ─────────────────────────────────────────────────────────

const PRESET_AMOUNTS = [5_000, 19_000, 38_000, 95_000, 190_000] as const;

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtDollars(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DwZScreen() {
  const data = useAppStore((state) => state.appliedData);
  const assumptions = useAppStore((state) => state.appliedAssumptions);
  const selectedStressors = useAppStore(
    (state) => state.appliedSelectedStressors,
  );
  const selectedResponses = useAppStore(
    (state) => state.appliedSelectedResponses,
  );
  const setCurrentScreen = useAppStore((state) => state.setCurrentScreen);

  const cluster = useClusterSession();
  const dispatcherUrl = cluster.snapshot.dispatcherUrl ?? null;

  const lastPolicyAdoption = useAppStore((state) => state.lastPolicyAdoption);

  const recommendation = useRecommendedPolicy(
    data ?? null,
    assumptions ?? null,
    selectedStressors ?? [],
    selectedResponses ?? [],
    dispatcherUrl,
    lastPolicyAdoption,
  );

  // Build fingerprint + mining assumptions once
  const baselineFingerprint = useMemo(() => {
    if (!data || !assumptions) return null;
    try {
      const base = buildEvaluationFingerprint({
        data,
        assumptions,
        selectedStressors: selectedStressors ?? [],
        selectedResponses: selectedResponses ?? [],
      });
      return `${base}|trials=${POLICY_MINING_TRIAL_COUNT}|fpv1`;
    } catch {
      return null;
    }
  }, [data, assumptions, selectedStressors, selectedResponses]);

  const legacyTargetTodayDollars =
    data?.goals?.legacyTargetTodayDollars ?? DEFAULT_LEGACY_TARGET_TODAY_DOLLARS;

  // ── Form state ─────────────────────────────────────────────────────────────
  const currentCalendarYear = new Date().getFullYear();
  const [recipient, setRecipient] = useState('ethan');
  const [year, setYear] = useState(currentCalendarYear);
  const [selectedPreset, setSelectedPreset] = useState<number | 'custom'>(19_000);
  const [customAmount, setCustomAmount] = useState('');
  const [sourceAccount, setSourceAccount] =
    useState<ScheduledOutflow['sourceAccount']>('cash');
  const [vehicle, setVehicle] =
    useState<ScheduledOutflow['vehicle']>('annual_exclusion_cash');

  const amount =
    selectedPreset === 'custom'
      ? parseFloat(customAmount.replace(/[^0-9.]/g, '')) || 0
      : selectedPreset;

  // ── Simulation state ───────────────────────────────────────────────────────
  type SimResult = Awaited<ReturnType<typeof simulateGift>>;
  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);

  // ── Copy-payload state ─────────────────────────────────────────────────────
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Run simulation when inputs change (debounced) ──────────────────────────
  const simAbortRef = useRef<AbortController | null>(null);

  const runSim = useCallback(async () => {
    if (
      !data ||
      !assumptions ||
      !baselineFingerprint ||
      recommendation.state !== 'fresh' ||
      !recommendation.policy
    ) {
      return;
    }

    if (amount <= 0) {
      setSimResult(null);
      return;
    }

    // Abort any in-flight sim
    simAbortRef.current?.abort();
    const abort = new AbortController();
    simAbortRef.current = abort;

    setSimLoading(true);
    setSimError(null);

    const cloner = (d: typeof data) => JSON.parse(JSON.stringify(d)) as typeof data;

    const miningAssumptions = {
      ...assumptions,
      simulationRuns: POLICY_MINING_TRIAL_COUNT,
      assumptionsVersion: assumptions.assumptionsVersion
        ? `${assumptions.assumptionsVersion}-dwz-whatif`
        : 'dwz-whatif',
    };

    const ctx: EvalContext = {
      assumptions: miningAssumptions,
      baselineFingerprint,
      engineVersion: POLICY_MINER_ENGINE_VERSION,
      evaluatedByNodeId: 'local-browser',
      cloner,
      legacyTargetTodayDollars,
    };

    const outflow: ScheduledOutflow = {
      name: `${recipient.replace(/\s+/g, '_')}_${vehicle}_${year}`,
      year,
      amount,
      sourceAccount,
      recipient,
      vehicle,
      label: `${recipient} gift — ${vehicle.replace(/_/g, ' ')} ${year}`,
      taxTreatment:
        vehicle === 'annual_exclusion_cash' && amount > 38_000
          ? 'requires_form_709'
          : 'gift_no_tax_consequence',
    };

    try {
      const result = await simulateGift(
        cloner(data),
        recommendation.policy.policy,
        [outflow],
        ctx,
      );
      if (!abort.signal.aborted) {
        setSimResult(result);
        setSimLoading(false);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        setSimError(err instanceof Error ? err.message : String(err));
        setSimLoading(false);
      }
    }
  }, [
    data,
    assumptions,
    baselineFingerprint,
    recommendation,
    amount,
    year,
    recipient,
    sourceAccount,
    vehicle,
    legacyTargetTodayDollars,
  ]);

  // Debounce: run 600ms after the last input change
  useEffect(() => {
    const timer = setTimeout(() => {
      void runSim();
    }, 600);
    return () => clearTimeout(timer);
  }, [runSim]);

  // ── Copy payload ───────────────────────────────────────────────────────────
  const handleCopyPayload = useCallback(() => {
    const outflow: ScheduledOutflow = {
      name: `${recipient.replace(/\s+/g, '_')}_${vehicle}_${year}`,
      year,
      amount,
      sourceAccount,
      recipient,
      vehicle,
      label: `${recipient} gift — ${vehicle.replace(/_/g, ' ')} ${year}`,
      taxTreatment:
        vehicle === 'annual_exclusion_cash' && amount > 38_000
          ? 'requires_form_709'
          : 'gift_no_tax_consequence',
    };
    const payload = buildAnnualAdoptionPayload([outflow], currentCalendarYear);
    const json = formatPayloadForClipboard(payload);

    navigator.clipboard.writeText(json).then(
      () => {
        setCopyStatus('copied');
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopyStatus('idle'), 2500);
      },
      () => {
        setCopyStatus('error');
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopyStatus('idle'), 2500);
      },
    );
  }, [recipient, vehicle, year, amount, sourceAccount, currentCalendarYear]);

  // ── Corpus state guards ────────────────────────────────────────────────────
  if (!data || !assumptions) {
    return (
      <div className="rounded-2xl border border-stone-200 bg-white/70 p-6 text-stone-500">
        <p>Load a plan first — DwZ needs a baseline to work against.</p>
      </div>
    );
  }

  if (recommendation.state === 'loading') {
    return (
      <div className="flex min-h-[30vh] flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-stone-200 border-t-blue-600" />
        <p className="text-sm font-medium text-stone-500">Loading corpus…</p>
      </div>
    );
  }

  if (recommendation.state === 'no-corpus') {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-stone-900">
            Generosity (Die-With-Zero)
          </h1>
        </div>
        <div className="rounded-2xl border border-stone-200 bg-white/70 p-6">
          <p className="text-stone-700">
            DwZ requires a mined corpus to run what-if simulations.
          </p>
          <p className="mt-1 text-sm text-stone-500">
            Without a corpus, there&apos;s no recommended policy to hold constant
            during the gift scenario comparison.
          </p>
          <button
            type="button"
            onClick={() => setCurrentScreen('mining')}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 active:bg-blue-800"
          >
            Run a mine first →
          </button>
        </div>
      </div>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────
  const isStale = recommendation.state === 'stale-corpus';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-stone-900">
          Generosity (Die-With-Zero)
        </h1>
        <p className="mt-1 text-[12px] text-stone-500 max-w-2xl">
          See how a one-time gift changes your end amount before committing. Enter
          the gift details, review the impact, then copy the adoption payload to
          paste into <code className="font-mono">seed-data.json</code>.
        </p>
      </div>

      {/* Stale-corpus banner */}
      {isStale && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <span className="mt-0.5 text-amber-600" aria-hidden>
            ⚠
          </span>
          <div className="flex-1 text-sm text-amber-800">
            <span className="font-medium">Plan has changed since last mine.</span>{' '}
            Re-mine for accurate numbers.{' '}
            <button
              type="button"
              onClick={() => setCurrentScreen('mining')}
              className="underline hover:no-underline"
            >
              Re-mine →
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ── Left: gift inputs ── */}
        <div className="rounded-2xl border border-stone-200 bg-white/70 p-6 space-y-5">
          <h2 className="text-sm font-semibold text-stone-700 uppercase tracking-wide">
            Gift details
          </h2>

          {/* Recipient */}
          <div className="space-y-1">
            <label
              htmlFor="dwz-recipient"
              className="block text-sm font-medium text-stone-600"
            >
              Recipient
            </label>
            <input
              id="dwz-recipient"
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="e.g. ethan, mavue"
              className="w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800 placeholder-stone-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>

          {/* Year */}
          <div className="space-y-1">
            <label
              htmlFor="dwz-year"
              className="block text-sm font-medium text-stone-600"
            >
              Year
            </label>
            <input
              id="dwz-year"
              type="number"
              value={year}
              onChange={(e) => setYear(parseInt(e.target.value, 10) || currentCalendarYear)}
              min={currentCalendarYear}
              max={currentCalendarYear + 30}
              className="w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>

          {/* Amount — preset pills */}
          <div className="space-y-2">
            <span className="block text-sm font-medium text-stone-600">Amount</span>
            <div className="flex flex-wrap gap-2">
              {PRESET_AMOUNTS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setSelectedPreset(preset)}
                  className={[
                    'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                    selectedPreset === preset
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-stone-200 bg-stone-50 text-stone-700 hover:border-blue-300 hover:bg-blue-50',
                  ].join(' ')}
                >
                  {fmtDollars(preset)}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setSelectedPreset('custom')}
                className={[
                  'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                  selectedPreset === 'custom'
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-stone-200 bg-stone-50 text-stone-700 hover:border-blue-300 hover:bg-blue-50',
                ].join(' ')}
              >
                Custom
              </button>
            </div>
            {selectedPreset === 'custom' && (
              <input
                type="text"
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
                placeholder="Enter amount, e.g. 25000"
                className="mt-2 w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800 placeholder-stone-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            )}
          </div>

          {/* Source account */}
          <div className="space-y-1">
            <label
              htmlFor="dwz-source"
              className="block text-sm font-medium text-stone-600"
            >
              Source account
            </label>
            <select
              id="dwz-source"
              value={sourceAccount}
              onChange={(e) =>
                setSourceAccount(e.target.value as ScheduledOutflow['sourceAccount'])
              }
              className="w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            >
              <option value="cash">Cash</option>
              <option value="taxable">Taxable</option>
              <option value="pretax">Pre-tax (401k/IRA)</option>
              <option value="roth">Roth</option>
            </select>
          </div>

          {/* Vehicle */}
          <div className="space-y-1">
            <label
              htmlFor="dwz-vehicle"
              className="block text-sm font-medium text-stone-600"
            >
              Gift vehicle
            </label>
            <select
              id="dwz-vehicle"
              value={vehicle}
              onChange={(e) =>
                setVehicle(e.target.value as ScheduledOutflow['vehicle'])
              }
              className="w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-800 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            >
              <option value="annual_exclusion_cash">
                Annual exclusion cash ($38K joint limit)
              </option>
              <option value="529_superfund">
                529 superfund (5-yr IRS election, $190K joint)
              </option>
              <option value="direct_pay_tuition_medical">
                Direct-pay tuition / medical (unlimited)
              </option>
              <option value="utma">UTMA</option>
              <option value="other">Other</option>
            </select>
            {vehicle === 'annual_exclusion_cash' && amount > 38_000 && (
              <p className="text-[11px] text-amber-700 mt-1">
                Amount exceeds $38K joint annual exclusion — will be tagged{' '}
                <code className="font-mono">requires_form_709</code>. IRS Form
                709 tracks lifetime exemption usage even when no tax is owed.
              </p>
            )}
          </div>
        </div>

        {/* ── Right: simulation output + copy ── */}
        <div className="rounded-2xl border border-stone-200 bg-white/70 p-6 space-y-5">
          <h2 className="text-sm font-semibold text-stone-700 uppercase tracking-wide">
            Projected impact
          </h2>

          {simLoading && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-stone-200 border-t-blue-600" />
              <p className="text-sm text-stone-500">
                Simulating gift ({POLICY_MINING_TRIAL_COUNT.toLocaleString()} trials)…
              </p>
            </div>
          )}

          {simError && !simLoading && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              Simulation error: {simError}
            </div>
          )}

          {!simLoading && !simError && simResult === null && amount > 0 && (
            <p className="text-sm text-stone-400 py-8 text-center">
              Running simulation…
            </p>
          )}

          {!simLoading && !simError && amount <= 0 && (
            <p className="text-sm text-stone-400 py-8 text-center">
              Enter a gift amount to see the projected impact.
            </p>
          )}

          {!simLoading && !simError && simResult !== null && (
            <div className="space-y-4">
              {/* Terminal wealth */}
              <div className="rounded-xl bg-stone-50 p-4 space-y-1">
                <p className="text-xs font-medium text-stone-500 uppercase tracking-wide">
                  Median end amount (today $)
                </p>
                <p className="text-sm text-stone-700">
                  <span className="font-mono">
                    {fmtDollars(simResult.baseline.medianEndingWealthTodayDollars)}
                  </span>{' '}
                  →{' '}
                  <span
                    className={[
                      'font-mono font-semibold',
                      simResult.withGift.medianEndingWealthTodayDollars <
                      simResult.baseline.medianEndingWealthTodayDollars
                        ? 'text-amber-700'
                        : 'text-green-700',
                    ].join(' ')}
                  >
                    {fmtDollars(simResult.withGift.medianEndingWealthTodayDollars)}
                  </span>
                  <span className="ml-2 text-xs text-stone-400">
                    ({simResult.delta.medianEndingWealthTodayDollars >= 0 ? '+' : ''}
                    {fmtDollars(simResult.delta.medianEndingWealthTodayDollars)})
                  </span>
                </p>
              </div>

              {/* Plan success */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-stone-50 p-3 space-y-0.5">
                  <p className="text-xs text-stone-500">Plan success</p>
                  <p className="text-sm font-semibold text-stone-800">
                    {fmtPct(simResult.baseline.solventSuccessRate)}{' '}
                    <span className="font-normal text-stone-500">→</span>{' '}
                    <span
                      className={
                        simResult.withGift.solventSuccessRate <
                        simResult.baseline.solventSuccessRate
                          ? 'text-amber-700'
                          : 'text-stone-800'
                      }
                    >
                      {fmtPct(simResult.withGift.solventSuccessRate)}
                    </span>
                  </p>
                </div>

                <div className="rounded-xl bg-stone-50 p-3 space-y-0.5">
                  <p className="text-xs text-stone-500">25th-pctile end</p>
                  <p className="text-sm font-semibold text-stone-800">
                    <span className="font-mono">
                      {fmtDollars(simResult.baseline.p25EndingWealthTodayDollars)}
                    </span>{' '}
                    <span className="font-normal text-stone-500">→</span>{' '}
                    <span
                      className={[
                        'font-mono',
                        simResult.withGift.p25EndingWealthTodayDollars <
                        simResult.baseline.p25EndingWealthTodayDollars
                          ? 'text-amber-700'
                          : 'text-stone-800',
                      ].join(' ')}
                    >
                      {fmtDollars(simResult.withGift.p25EndingWealthTodayDollars)}
                    </span>
                  </p>
                </div>

                <div className="rounded-xl bg-stone-50 p-3 space-y-0.5 col-span-2">
                  <p className="text-xs text-stone-500">Bequest attainment</p>
                  <p className="text-sm font-semibold text-stone-800">
                    {fmtPct(simResult.baseline.bequestAttainmentRate)}{' '}
                    <span className="font-normal text-stone-500">→</span>{' '}
                    <span
                      className={
                        simResult.withGift.bequestAttainmentRate <
                        simResult.baseline.bequestAttainmentRate
                          ? 'text-amber-700'
                          : 'text-stone-800'
                      }
                    >
                      {fmtPct(simResult.withGift.bequestAttainmentRate)}
                    </span>
                    <span className="ml-2 text-xs font-normal text-stone-400">
                      (target: {fmtDollars(legacyTargetTodayDollars)})
                    </span>
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Copy-payload button + instructions */}
          <div className="border-t border-stone-100 pt-4 space-y-3">
            <button
              type="button"
              disabled={amount <= 0 || simLoading}
              onClick={handleCopyPayload}
              className={[
                'w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors',
                amount > 0 && !simLoading
                  ? 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800'
                  : 'cursor-not-allowed bg-stone-200 text-stone-400',
              ].join(' ')}
            >
              {copyStatus === 'copied'
                ? 'Copied!'
                : copyStatus === 'error'
                ? 'Copy failed — try again'
                : 'Copy adoption payload'}
            </button>

            <p className="text-[11px] text-stone-400 leading-relaxed">
              Paste this into{' '}
              <code className="font-mono text-stone-500">seed-data.json</code>{' '}
              by appending the{' '}
              <code className="font-mono text-stone-500">scheduledOutflows</code>{' '}
              array entries to the existing top-level{' '}
              <code className="font-mono text-stone-500">scheduledOutflows</code>{' '}
              array (or creating it if absent). After saving, the miner will
              re-mine on the next cockpit load (~3 min).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
