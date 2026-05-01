import { useMemo } from 'react';
import {
  computeMedicareMilestones,
  type MedicareIepStage,
} from './medicare-milestones';
import type { SeedData } from './types';

const STAGE_TONE: Record<MedicareIepStage, string> = {
  far_off: 'text-stone-700 bg-stone-50 border-stone-200',
  approaching: 'text-amber-800 bg-amber-50 border-amber-200',
  in_window: 'text-rose-800 bg-rose-50 border-rose-300',
  missed: 'text-rose-900 bg-rose-100 border-rose-400',
  enrolled_or_past: 'text-stone-600 bg-stone-50 border-stone-200',
};

/**
 * Medicare-IEP awareness card. Surfaces only when at least one spouse
 * is within ~24 months of age 65, or there's an HSA-contribution
 * conflict with the 6-month look-back window. Designed to live in
 * the Cockpit's "Hard stops on the radar" panel — same visual class
 * as IRMAA-cliff cards.
 */
export function MedicareReminderCard({ data }: { data: SeedData }) {
  const report = useMemo(() => computeMedicareMilestones(data), [data]);
  if (!report.hasActionableSignal) return null;

  return (
    <div className="md:col-span-2 rounded-xl border border-blue-200 bg-blue-50/50 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-700">
        Medicare IEP · age 65 enrollment
      </p>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        {report.milestones.map((m) => (
          <div
            key={m.person}
            className={`rounded-lg border p-2 text-[12px] ${STAGE_TONE[m.stage]}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">{m.displayName}</span>
              <span className="text-[11px] tabular-nums">
                {m.age65Date.toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            </div>
            <p className="mt-1">{m.stageLabel}</p>
            {m.nextEscalationLabel && (
              <p className="mt-0.5 text-[11px] opacity-80">
                {m.nextEscalationLabel}
              </p>
            )}
          </div>
        ))}
      </div>

      {report.hsaConflicts.length > 0 && (
        <div className="mt-2 rounded-lg border border-rose-300 bg-rose-50 p-2 text-[12px] text-rose-900">
          <p className="font-semibold">
            ⚠️ HSA contribution conflict with Medicare 6-month look-back
          </p>
          <ul className="mt-1 space-y-1">
            {report.hsaConflicts.map((c) => (
              <li key={c.person}>{c.message}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-2 text-[11px] text-stone-500">
        Medicare's Initial Enrollment Period spans 7 months — 3 before
        the 65th birthday, the birth month, and 3 after. Missing it
        triggers a permanent Part B premium penalty (10%/yr of delay)
        plus coverage gaps. Sign up at MyMedicare.gov.
      </p>
    </div>
  );
}
