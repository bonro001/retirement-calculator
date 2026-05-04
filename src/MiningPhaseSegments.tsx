/**
 * Mining Phase Segments — three-segment progress control that turns the
 * pass-1 → pass-2 pipeline into a single forward-moving story for the
 * household.
 *
 *   ┌────────── Explore ──────────┐ → ┌── Refine ──┐ → ┌─ Ranked ─┐
 *   │      12,342 candidates       │   │ ~1,150     │   │ pol_xxxx  │
 *   │      1m 26s                   │   │ 18s        │   │ done      │
 *   └─────────────────────────────┘   └────────────┘   └───────────┘
 *
 * Why three: the household thinks "explore wide, refine on what
 * matters, done." Cliff refinement and rule sweep are technical
 * details inside "refine" — surfacing them as separate segments
 * leaks the implementation. Three reads cleanly and conveys the
 * trust-building shrink ("12k → 1k → 1 recommendation").
 *
 * Pure presentational. The owning component computes the phase state
 * and passes it in.
 */

export type PipelinePhase = 'idle' | 'exploring' | 'refining' | 'done';

export interface MiningPhaseSegmentsProps {
  phase: PipelinePhase;
  /** Pass-1 candidate count (total grid). Shown in the "Explore"
   *  segment whenever known, regardless of phase. */
  pass1Total?: number | null;
  /** Pass-1 candidates evaluated so far. Shown during 'exploring'. */
  pass1Evaluated?: number | null;
  /** Pass-2 candidate count (estimated or actual). Shown in "Refine"
   *  once the pipeline transitions out of 'exploring'. */
  pass2Total?: number | null;
  /** Pass-2 candidates evaluated so far. Shown during 'refining'. */
  pass2Evaluated?: number | null;
  /** Best policy id from the corpus, shown in the "Ranked" segment when
   *  phase === 'done'. */
  bestPolicyId?: string | null;
  /** When the user has bypassed the auto-pipeline (e.g., Quick mine or
   *  manual axesOverride), hide the control entirely. */
  hidden?: boolean;
}

const segmentBase =
  'flex-1 rounded-md border px-3 py-2 transition text-left';

export function MiningPhaseSegments({
  phase,
  pass1Total,
  pass1Evaluated,
  pass2Total,
  pass2Evaluated,
  bestPolicyId,
  hidden,
}: MiningPhaseSegmentsProps) {
  if (hidden) return null;
  if (phase === 'idle') return null;

  const segmentClasses = (
    seg: 'explore' | 'refine' | 'ranked',
  ): string => {
    const isActive =
      (seg === 'explore' && phase === 'exploring') ||
      (seg === 'refine' && phase === 'refining') ||
      (seg === 'ranked' && phase === 'done');
    const isComplete =
      (seg === 'explore' && (phase === 'refining' || phase === 'done')) ||
      (seg === 'refine' && phase === 'done');

    if (isActive) {
      return `${segmentBase} border-emerald-300 bg-emerald-50 shadow-sm animate-pulse`;
    }
    if (isComplete) {
      return `${segmentBase} border-emerald-200 bg-emerald-50/40`;
    }
    return `${segmentBase} border-stone-200 bg-stone-50 opacity-60`;
  };

  const statusLabel = (
    seg: 'explore' | 'refine' | 'ranked',
  ): string => {
    if (seg === 'explore') {
      if (phase === 'exploring') return 'searching the grid';
      if (phase === 'refining' || phase === 'done') return 'complete';
    }
    if (seg === 'refine') {
      if (phase === 'exploring') return 'pending';
      if (phase === 'refining') return 'narrowing on contenders';
      if (phase === 'done') return 'complete';
    }
    if (seg === 'ranked') {
      if (phase === 'done') return 'recommendation ready';
      return 'pending';
    }
    return '';
  };

  return (
    <div className="rounded-2xl border border-stone-200 bg-white/70 p-3 shadow-sm">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-stone-500">
        Mining pipeline
      </p>
      <div className="flex items-stretch gap-2">
        <Segment
          className={segmentClasses('explore')}
          title="Explore"
          subtitle={
            pass1Total != null
              ? phase === 'exploring' && pass1Evaluated != null
                ? `${pass1Evaluated.toLocaleString()} / ${pass1Total.toLocaleString()} candidates`
                : `${pass1Total.toLocaleString()} candidates`
              : 'wide grid sweep'
          }
          status={statusLabel('explore')}
        />
        <Arrow />
        <Segment
          className={segmentClasses('refine')}
          title="Refine"
          subtitle={
            pass2Total != null
              ? phase === 'refining' && pass2Evaluated != null
                ? `${pass2Evaluated.toLocaleString()} / ${pass2Total.toLocaleString()} contenders`
                : `~${pass2Total.toLocaleString()} contenders`
              : 'cliff + rule comparison'
          }
          status={statusLabel('refine')}
        />
        <Arrow />
        <Segment
          className={segmentClasses('ranked')}
          title="Ranked"
          subtitle={
            phase === 'done' && bestPolicyId
              ? bestPolicyId.replace(/^pol_/, 'pol·').slice(0, 12)
              : 'recommendation'
          }
          status={statusLabel('ranked')}
        />
      </div>
    </div>
  );
}

function Segment({
  className,
  title,
  subtitle,
  status,
}: {
  className: string;
  title: string;
  subtitle: string;
  status: string;
}) {
  return (
    <div className={className}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-700">
        {title}
      </p>
      <p className="mt-0.5 text-[12px] text-stone-800">{subtitle}</p>
      <p className="mt-0.5 text-[10px] text-stone-500">{status}</p>
    </div>
  );
}

function Arrow() {
  return (
    <span
      className="self-center text-stone-300"
      aria-hidden="true"
    >
      →
    </span>
  );
}
