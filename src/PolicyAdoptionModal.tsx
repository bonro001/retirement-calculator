import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  diffAdoption,
  formatBreakdownEntry,
  type AdoptionDiff,
} from './policy-adoption';
import type { Policy } from './policy-miner-types';
import type { SeedData } from './types';

/**
 * Policy Adoption — confirmation modal.
 *
 * The "victory lap" surface for E.2. The user has spent ~45 min mining
 * the cluster and identified a candidate they want to adopt; this is
 * where they verify the change before it lands in the draft plan.
 *
 * Design choices:
 *   - SHOW THE DELTA, not a form. The user already picked the policy in
 *     the table; the modal's job is to make crystal clear what fields
 *     change and to what values. No editing here — adopt or cancel.
 *
 *   - Spending breakdown is a sub-line, not a separate step. The
 *     scaling we apply (proportional across all four categories) is a
 *     defensible default but the user should SEE what it does to
 *     essentials vs travel. Keeping it inline avoids a wizard feel.
 *
 *   - "Run Plan Analysis after" is the explicit follow-up. Adoption
 *     stages the change into draft, same as any other edit. The
 *     existing "Plan data fresh" / "Run Plan Analysis" affordance
 *     above the screen is the next click. We don't auto-run because
 *     simulation can take 10+ seconds and the user might want to
 *     tweak something else first.
 *
 *   - Undoable. After this modal closes, the table shows an "Adopted X
 *     · Undo" banner. Adoption isn't a one-way door.
 *
 * Why a custom modal vs a portal library: the codebase has no shared
 * Modal primitive (verified by grep). Portal-and-overlay is a 30-line
 * pattern; pulling in headlessui/radix for a single surface would be
 * disproportionate. Revisit if a third modal lands.
 */

interface Props {
  policy: Policy;
  currentData: SeedData;
  onConfirm: () => void;
  onConfirmAndCertify?: () => void;
  secondaryActionLabel?: string;
  secondaryActionTitle?: string;
  secondaryActionDescription?: string;
  suppressPrimaryAdoption?: boolean;
  onCancel: () => void;
  /** True when the policy's baseline doesn't match the current plan
   *  (cluster session ran against different inputs). The modal surfaces
   *  this prominently because the bequest projections may not transfer. */
  baselineMismatch?: boolean;
}

export function PolicyAdoptionModal({
  policy,
  currentData,
  onConfirm,
  onConfirmAndCertify,
  secondaryActionLabel = 'Adopt and certify',
  secondaryActionTitle = 'Would you like to certify this after adoption?',
  secondaryActionDescription = 'Certification runs the dual-basis stress review and seed audit before treating this as authorized spending.',
  suppressPrimaryAdoption = false,
  onCancel,
  baselineMismatch = false,
}: Props): JSX.Element {
  const diff: AdoptionDiff = useMemo(
    () => diffAdoption(currentData, policy),
    [currentData, policy],
  );

  // Esc closes. Click on the backdrop closes. Don't trap focus — for a
  // single confirm/cancel modal the cost of a focus trap library
  // outweighs the marginal accessibility win.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    // Lock body scroll while open so the page doesn't jump under the
    // overlay. Restored on unmount.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onCancel]);

  const changedRows = diff.rows.filter((r) => r.changed);

  // Portal into document.body so the modal escapes any ancestor that
  // happens to set `transform`, `filter`, `backdrop-blur`, etc. — those
  // create a containing block for `position: fixed` children, causing
  // the overlay to anchor to the ancestor's box instead of the viewport.
  // The PolicyMiningResultsTable lives inside several wrapped sections
  // and at least one ancestor uses backdrop-blur, which is what was
  // pushing the modal far below the fold.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="adopt-policy-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/50 px-4 py-8 backdrop-blur-sm"
      onClick={(e) => {
        // Click on backdrop closes; clicks inside the panel bubble up
        // and are caught by the panel's stopPropagation.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-stone-200"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-stone-200 px-6 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Review mined policy
          </p>
          <h2
            id="adopt-policy-title"
            className="mt-1 text-lg font-semibold text-stone-900"
          >
            {diff.summary}
          </h2>
          <p className="mt-1 text-[12px] text-stone-500">
            {suppressPrimaryAdoption ? (
              'Review these values before changing your draft plan.'
            ) : (
              <>
                Review these values before staging them into your draft plan.
                Click{' '}
                <span className="font-semibold text-stone-700">
                  Run Plan Analysis
                </span>{' '}
                after to see updated projections.
              </>
            )}
          </p>
        </header>

        <div className="px-6 py-4">
          {baselineMismatch && (
            <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              This session was mined against a different baseline than your
              current plan. The policy choice (spend, SS ages, Roth max)
              still adopts cleanly, but the bequest numbers in the table may
              not transfer exactly — re-run Plan Analysis to see your
              real-baseline result.
            </p>
          )}

          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 text-[11px] font-medium uppercase tracking-wider text-stone-500">
                <th className="py-2 pr-3">Field</th>
                <th className="py-2 pr-3">Current</th>
                <th className="py-2 pr-3">→</th>
                <th className="py-2">New</th>
              </tr>
            </thead>
            <tbody>
              {diff.rows.map((row) => (
                <tr
                  key={row.key}
                  className={`border-b border-stone-100 last:border-b-0 ${
                    row.changed ? '' : 'text-stone-400'
                  }`}
                >
                  <td className="py-2 pr-3 font-medium text-stone-700">
                    {row.label}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">
                    {row.currentLabel}
                  </td>
                  <td className="py-2 pr-3 text-stone-400">→</td>
                  <td
                    className={`py-2 tabular-nums ${
                      row.changed ? 'font-semibold text-emerald-700' : ''
                    }`}
                  >
                    {row.proposedLabel}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {changedRows.some((r) => r.key === 'spend') && (
            <details className="mt-3 rounded-md bg-stone-50 px-3 py-2 text-[12px] text-stone-600">
              <summary className="cursor-pointer font-medium text-stone-700">
                How the {diff.summary.split(' · ')[0]} target splits across
                categories
              </summary>
              <ul className="mt-2 space-y-1 pl-4">
                {diff.spendingBreakdown.map((entry) => (
                  <li key={entry.key} className="tabular-nums">
                    {formatBreakdownEntry(entry)}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-stone-500">
                Optional spending is adjusted so core annual spend matches the
                policy. Travel stays as a separate yearly goal.
              </p>
            </details>
          )}

          <p className="mt-4 text-[11px] text-stone-500">
            {suppressPrimaryAdoption
              ? 'No plan values are changed from this review step.'
              : 'Accounts and contributions are not modified. The previous values are saved so you can undo this in one click.'}
          </p>

          {onConfirmAndCertify && (
            <div className="mt-3 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-[12px] text-blue-900">
              <p className="font-semibold">{secondaryActionTitle}</p>
              <p className="mt-1 text-blue-800">
                {secondaryActionDescription}
              </p>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 bg-stone-50 px-6 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full px-4 py-1.5 text-[12px] font-semibold text-stone-700 transition hover:bg-stone-200"
          >
            Cancel
          </button>
          {!suppressPrimaryAdoption && (
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-full bg-emerald-600 px-4 py-1.5 text-[12px] font-semibold text-white shadow-sm transition hover:bg-emerald-700"
            >
              Adopt this plan
            </button>
          )}
          {onConfirmAndCertify && (
            <button
              type="button"
              onClick={onConfirmAndCertify}
              className="rounded-full bg-blue-600 px-4 py-1.5 text-[12px] font-semibold text-white shadow-sm transition hover:bg-blue-700"
            >
              {secondaryActionLabel}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
