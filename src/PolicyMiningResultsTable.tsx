import { useEffect, useMemo, useState } from 'react';
import { loadEvaluationsForBaseline } from './policy-mining-corpus';
import type { Policy, PolicyEvaluation } from './policy-miner-types';
import {
  loadClusterEvaluations,
  loadClusterSessions,
  type ClusterSessionListing,
} from './policy-mining-cluster';
import { PolicyAdoptionModal } from './PolicyAdoptionModal';
import { PolicyFrontierChart } from './PolicyFrontierChart';
import { SensitivityPanel } from './SensitivityPanel';
import { StressTestPanel } from './StressTestPanel';
import { explainAdoption } from './policy-adoption';
import { useAppStore } from './store';
import {
  LEGACY_ATTAINMENT_FLOOR,
  SOLVENCY_DEFENSE_FLOOR,
} from './policy-ranker';

/**
 * Policy Mining — Results Table.
 *
 * The corpus's job is to produce a ranked list of policies; this card's
 * job is to make that list a usable household decision tool. The user
 * doesn't want to read JSON — they want to see "if I delay primary SS
 * to 68 and cap Roth at $80k, I can spend $X more per year with Y%
 * confidence I leave the bequest goal."
 *
 * Two data sources:
 *
 *   - Local: the in-browser IndexedDB corpus written by the 12-worker
 *     pool when mining runs in this tab. Filtered to the current
 *     baseline + engine version.
 *
 *   - Cluster: read directly from the dispatcher's HTTP API (no local
 *     mirroring). Lets the user inspect sessions that ran on the Mac
 *     mini / Ryzen / Mac Studio fleet — including ones that finished
 *     hours ago — without re-running them. Every session the
 *     dispatcher knows about appears in the picker; sessions that
 *     match the current baseline fingerprint are labelled so the user
 *     can tell at a glance whether the rows are comparable to their
 *     current plan.
 *
 * Design choices:
 *   - Only feasible records (configurable threshold) — non-feasible
 *     candidates are search-space exhaust, not recommendations.
 *   - Sort by SPEND DESC by default to match the V1 ranking objective
 *     (feasibility floor + max spend). Bequest is the tiebreaker.
 *   - Diff columns vs the household's current plan when provided. A
 *     plan-relative view ("$15k/yr more spend than today, $200k more
 *     bequest") is more actionable than the absolute numbers alone.
 *   - Top 25 rows by default. The corpus may have hundreds of feasible
 *     entries; rendering them all is expensive and unhelpful for a
 *     decision card. A future "show all" toggle can lift that cap.
 */

// Browser memory mitigation: at Full mine scale (~7,776 polices), the
// `loadClusterEvaluations` response grows to ~10MB of JS objects per
// poll. At a 5-second interval over a 10-min Full mine, that's ~120
// allocations of growing arrays through React state. If GC can't keep
// up, Chrome OOMs (Error code 5). 30s gives GC enough breathing room
// and is responsive enough for "watch results land" UX. The deeper
// fix is server-side top-N capping so the payload doesn't grow
// unboundedly — see the deferred follow-up that pairs with this.
const POLL_INTERVAL_MS = 30_000;
const SESSION_LIST_POLL_MS = 10_000;
const DEFAULT_FEASIBILITY_THRESHOLD = LEGACY_ATTAINMENT_FLOOR;
const DEFAULT_ROW_LIMIT = 25;

interface CurrentPlanReference {
  /** What the household spends today, today's $. Used for spend-diff column. */
  annualSpendTodayDollars: number;
  /** Current plan's primary SS claim age, for diff column. Null = unknown. */
  primarySocialSecurityClaimAge?: number | null;
  /** Current plan's spouse SS claim age, for diff column. Null = no spouse. */
  spouseSocialSecurityClaimAge?: number | null;
  /** Current Roth conversion ceiling, for diff column. */
  rothConversionAnnualCeiling?: number | null;
  /** Current plan's median bequest in today's $, for bequest-diff column. */
  p50EndingWealthTodayDollars?: number | null;
}

interface Props {
  baselineFingerprint: string | null;
  engineVersion: string;
  /**
   * Dispatcher WebSocket URL — same value the cluster status card uses.
   * When provided, the table exposes a "Cluster" source toggle that
   * pulls sessions from `<dispatcher>/sessions`. Omit to hide the toggle
   * (table behaves as local-only).
   */
  dispatcherUrl?: string | null;
  /**
   * If provided, the table renders Δ-vs-current columns. Without it, the
   * table still works but only shows absolute numbers.
   */
  currentPlan?: CurrentPlanReference;
  /** Current household legacy target, used to avoid showing stale zero-target mines as decision-grade. */
  legacyTargetTodayDollars?: number;
  /** Default feasibility threshold (0..1). Defaults to 0.85. */
  defaultFeasibilityThreshold?: number;
  /** Max rows to render. Defaults to 25. */
  rowLimit?: number;
  /**
   * E.5 — when present, the post-adoption banner renders a Sensitivity
   * Panel that re-mines a 3⁴ grid around the adopted policy so the
   * household can see "is my pick stable if I bump one knob?". Optional
   * because callers without a live cluster baseline (read-only views)
   * can't run new mines anyway.
   */
  sensitivityControls?: {
    baseline: import('./types').SeedData;
    assumptions: import('./types').MarketAssumptions;
    legacyTargetTodayDollars: number;
  };
}

type Source = 'local' | 'cluster';

type SortKey =
  | 'spend'
  | 'feasibility'
  | 'solvent'
  | 'bequestP50'
  | 'bequestP10'
  | 'primarySs'
  | 'spouseSs'
  | 'roth';

interface SortSpec {
  key: SortKey;
  direction: 'asc' | 'desc';
}

function formatCurrency(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}k`;
  return `$${Math.round(amount)}`;
}

function formatSpendStep(levels: number[]): string | null {
  if (levels.length < 2) return null;
  let step: number | null = null;
  for (let i = 1; i < levels.length; i += 1) {
    const diff = levels[i]! - levels[i - 1]!;
    if (diff <= 0) continue;
    step = step === null ? diff : Math.min(step, diff);
  }
  return step !== null ? `${formatCurrency(step)} steps` : null;
}

function formatPct(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

function formatDelta(
  delta: number,
  formatter: (n: number) => string,
): { text: string; tone: 'positive' | 'negative' | 'neutral' } {
  if (!Number.isFinite(delta) || delta === 0) {
    return { text: '—', tone: 'neutral' };
  }
  const sign = delta > 0 ? '+' : '−';
  const abs = Math.abs(delta);
  return {
    text: `${sign}${formatter(abs)}`,
    tone: delta > 0 ? 'positive' : 'negative',
  };
}

function deltaClass(tone: 'positive' | 'negative' | 'neutral'): string {
  switch (tone) {
    case 'positive':
      return 'text-emerald-700';
    case 'negative':
      return 'text-rose-600';
    default:
      return 'text-stone-400';
  }
}

function ageOrDash(age: number | null | undefined): string {
  if (age == null) return '—';
  return String(age);
}

function compareEvals(a: PolicyEvaluation, b: PolicyEvaluation, sort: SortSpec): number {
  const dir = sort.direction === 'asc' ? 1 : -1;
  const pick = (e: PolicyEvaluation): number => {
    switch (sort.key) {
      case 'spend':
        return e.policy.annualSpendTodayDollars;
      case 'feasibility':
        return e.outcome.bequestAttainmentRate;
      case 'solvent':
        return e.outcome.solventSuccessRate;
      case 'bequestP50':
        return e.outcome.p50EndingWealthTodayDollars;
      case 'bequestP10':
        return e.outcome.p10EndingWealthTodayDollars;
      case 'primarySs':
        return e.policy.primarySocialSecurityClaimAge;
      case 'spouseSs':
        return e.policy.spouseSocialSecurityClaimAge ?? 0;
      case 'roth':
        return e.policy.rothConversionAnnualCeiling;
    }
  };
  const av = pick(a);
  const bv = pick(b);
  if (av === bv) {
    // Stable tiebreak so toggling a column doesn't shuffle equal rows.
    return a.id.localeCompare(b.id);
  }
  return (av - bv) * dir;
}

function policyDiffSummary(
  policy: Policy,
  current?: CurrentPlanReference,
): string | null {
  if (!current) return null;
  const parts: string[] = [];
  if (
    current.primarySocialSecurityClaimAge != null &&
    policy.primarySocialSecurityClaimAge !== current.primarySocialSecurityClaimAge
  ) {
    const delta =
      policy.primarySocialSecurityClaimAge - current.primarySocialSecurityClaimAge;
    parts.push(`Pri SS ${delta > 0 ? '+' : ''}${delta}yr`);
  }
  if (
    current.spouseSocialSecurityClaimAge != null &&
    policy.spouseSocialSecurityClaimAge != null &&
    policy.spouseSocialSecurityClaimAge !== current.spouseSocialSecurityClaimAge
  ) {
    const delta =
      policy.spouseSocialSecurityClaimAge - current.spouseSocialSecurityClaimAge;
    parts.push(`Sp SS ${delta > 0 ? '+' : ''}${delta}yr`);
  }
  if (
    current.rothConversionAnnualCeiling != null &&
    policy.rothConversionAnnualCeiling !== current.rothConversionAnnualCeiling
  ) {
    const delta =
      policy.rothConversionAnnualCeiling - current.rothConversionAnnualCeiling;
    const sign = delta > 0 ? '+' : '−';
    parts.push(`Roth ${sign}${formatCurrency(Math.abs(delta))}/yr`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'same axes as current';
}

/** Format the picker label so the user can tell sessions apart at a glance. */
function describeSession(
  s: ClusterSessionListing,
  currentBaselineFingerprint: string | null,
): string {
  const when = new Date(s.lastActivityMs).toLocaleString();
  const stateBadge = s.summary
    ? s.summary.state
    : 'in progress';
  const matchTag =
    currentBaselineFingerprint &&
    s.manifest?.config?.baselineFingerprint === currentBaselineFingerprint
      ? ' · matches current'
      : '';
  return `${when} · ${s.evaluationCount.toLocaleString()} evals · ${stateBadge}${matchTag} · ${s.sessionId}`;
}

export function PolicyMiningResultsTable({
  baselineFingerprint,
  engineVersion,
  dispatcherUrl,
  currentPlan,
  legacyTargetTodayDollars,
  defaultFeasibilityThreshold = DEFAULT_FEASIBILITY_THRESHOLD,
  rowLimit = DEFAULT_ROW_LIMIT,
  sensitivityControls,
}: Props): JSX.Element | null {
  // Default to cluster when the dispatcher is connected — the household's
  // normal state has the cluster doing the mining work, so records live
  // server-side. Falls through to local-IDB only when cluster is offline,
  // matching what they'd actually have. The manual Local/Cluster toggle
  // is intentionally hidden below; corpus storage shouldn't be a
  // household-facing concern.
  const [source, setSource] = useState<Source>(
    dispatcherUrl ? 'cluster' : 'local',
  );
  const [evaluations, setEvaluations] = useState<PolicyEvaluation[]>([]);
  const [solvencyThreshold, setSolvencyThreshold] = useState<number>(
    SOLVENCY_DEFENSE_FLOOR,
  );
  const [spendFilter, setSpendFilter] = useState<number | null>(null);
  const [sort, setSort] = useState<SortSpec>({
    key: 'spend',
    direction: 'desc',
  });
  const [showAll, setShowAll] = useState<boolean>(false);

  // Cluster-mode state.
  const [clusterSessions, setClusterSessions] = useState<ClusterSessionListing[]>(
    [],
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [clusterError, setClusterError] = useState<string | null>(null);
  const [clusterLoading, setClusterLoading] = useState<boolean>(false);

  // E.2 — adoption state. The modal is open when `adoptingPolicy` is set.
  // The undo banner lives at the top of the table when the store has a
  // recent adoption to revert. Pulling the seed via the store rather
  // than threading it through props because the modal needs CURRENT
  // values (not a snapshot from when the table mounted) to show the
  // diff accurately — the user might edit Spending while the modal is
  // open, though that's a corner case.
  const [adoptingPolicy, setAdoptingPolicy] = useState<Policy | null>(null);
  const currentSeed = useAppStore((s) => s.data);
  const adoptMinedPolicy = useAppStore((s) => s.adoptMinedPolicy);
  const lastPolicyAdoption = useAppStore((s) => s.lastPolicyAdoption);
  const undoLastPolicyAdoption = useAppStore((s) => s.undoLastPolicyAdoption);
  const clearLastPolicyAdoption = useAppStore((s) => s.clearLastPolicyAdoption);

  const clusterEnabled = !!dispatcherUrl;
  const selectedSession = clusterSessions.find(
    (s) => s.sessionId === selectedSessionId,
  );
  const spendLevels = useMemo(() => {
    const axis = selectedSession?.manifest?.config?.axes?.annualSpendTodayDollars;
    const sourceLevels =
      source === 'cluster' && axis && axis.length > 0
        ? axis
        : evaluations.map((e) => e.policy.annualSpendTodayDollars);
    return Array.from(new Set(sourceLevels)).sort((a, b) => a - b);
  }, [selectedSession, source, evaluations]);
  const spendRangeLabel = useMemo(() => {
    if (spendLevels.length === 0) return null;
    const min = spendLevels[0]!;
    const max = spendLevels[spendLevels.length - 1]!;
    const step = formatSpendStep(spendLevels);
    if (min === max) return `${formatCurrency(min)}/yr`;
    return `${formatCurrency(min)}-${formatCurrency(max)}/yr${step ? ` · ${step}` : ''}`;
  }, [spendLevels]);

  useEffect(() => {
    if (spendFilter === null || spendLevels.length === 0) return;
    if (!spendLevels.includes(spendFilter)) setSpendFilter(null);
  }, [spendFilter, spendLevels]);

  // If the dispatcher URL goes away (user cleared it), drop back to local
  // so the empty state isn't confusing.
  useEffect(() => {
    if (!clusterEnabled && source === 'cluster') {
      setSource('local');
      setEvaluations([]);
    }
  }, [clusterEnabled, source]);

  // Local-mode polling: same cadence as the status card so the two
  // panels stay in lockstep without sharing state.
  useEffect(() => {
    if (source !== 'local') return undefined;
    if (!baselineFingerprint) {
      setEvaluations([]);
      return undefined;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const evals = await loadEvaluationsForBaseline(
          baselineFingerprint,
          engineVersion,
        );
        if (!cancelled) setEvaluations(evals);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[mining-results-table] local poll failed:', e);
      }
    };
    void tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [source, baselineFingerprint, engineVersion]);

  // Cluster-mode session listing: poll on a slower cadence than the
  // evaluations themselves; the list rarely changes mid-session.
  useEffect(() => {
    if (source !== 'cluster' || !dispatcherUrl) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const sessions = await loadClusterSessions(dispatcherUrl);
        if (cancelled) return;
        setClusterSessions(sessions);
        setClusterError(null);
        // Auto-pick: prefer the freshest session matching the current
        // baseline, otherwise the freshest session overall. The picker
        // is intentionally hidden, so a newly completed remine must
        // replace an older matching session without user intervention.
        if (sessions.length > 0) {
          const baselineMatches = baselineFingerprint
            ? sessions.filter(
                (s) =>
                  s.manifest?.config?.baselineFingerprint === baselineFingerprint,
              )
            : [];
          const legacyTargetMatch =
            legacyTargetTodayDollars && legacyTargetTodayDollars > 0
              ? baselineMatches.find(
                  (s) =>
                    s.manifest?.legacyTargetTodayDollars ===
                    legacyTargetTodayDollars,
                )
              : null;
          const match = baselineMatches[0] ?? null;
          const preferred =
            legacyTargetMatch ??
            match ??
            sessions[0];
          if (preferred.sessionId !== selectedSessionId) {
            setSelectedSessionId(preferred.sessionId);
          }
        }
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setClusterError(message);
      }
    };
    void tick();
    const handle = setInterval(tick, SESSION_LIST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [
    source,
    dispatcherUrl,
    baselineFingerprint,
    selectedSessionId,
    legacyTargetTodayDollars,
  ]);

  // Cluster-mode evaluations: poll the selected session.
  // Phase 2.D: ask the dispatcher for only the top N results most of
  // the time (server-side filter+sort, then slice). The fetch payload
  // stays bounded regardless of how many polices the session has
  // evaluated, which is what kept Chrome from OOM'ing on Full mines.
  // Users who want the full corpus toggle "Show all" → we re-poll
  // without the cap (separate effect on `showAll`). The dispatcher's
  // `evaluationCount` in the response is the TRUE total so we still
  // display "X of Y feasible" honestly.
  //
  // Ask the dispatcher for rows already inside the user's risk band so
  // the bounded top-N response still contains the highest-spend choices
  // the table can actually show.
  const serverMinLegacy = Math.max(
    0.5,
    Math.floor(defaultFeasibilityThreshold * 20) / 20,
  );
  const serverMinSolvency = Math.max(
    0.5,
    Math.floor(solvencyThreshold * 20) / 20,
  );
  const [evaluationCount, setEvaluationCount] = useState<number>(0);
  useEffect(() => {
    if (source !== 'cluster' || !dispatcherUrl || !selectedSessionId) {
      if (source === 'cluster') {
        setEvaluations([]);
        setEvaluationCount(0);
      }
      return undefined;
    }
    let cancelled = false;
    const topN = showAll ? 0 : Math.max(50, rowLimit * 4);
    const tick = async () => {
      setClusterLoading(true);
      try {
        const payload = await loadClusterEvaluations(
          dispatcherUrl,
          selectedSessionId,
          {
            topN,
            minFeasibility: serverMinLegacy,
            minSolvency: serverMinSolvency,
            spend: spendFilter ?? undefined,
          },
        );
        if (cancelled) return;
        setEvaluations(payload.evaluations);
        setEvaluationCount(payload.evaluationCount ?? payload.evaluations.length);
        setClusterError(null);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setClusterError(message);
      } finally {
        if (!cancelled) setClusterLoading(false);
      }
    };
    void tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [
    source,
    dispatcherUrl,
    selectedSessionId,
    showAll,
    rowLimit,
    serverMinLegacy,
    serverMinSolvency,
    spendFilter,
  ]);

  const filtered = useMemo(() => {
    return evaluations
      .filter(
        (e) =>
          e.outcome.bequestAttainmentRate >= defaultFeasibilityThreshold &&
          e.outcome.solventSuccessRate >= solvencyThreshold &&
          (spendFilter === null ||
            e.policy.annualSpendTodayDollars === spendFilter),
      )
      .sort((a, b) => compareEvals(a, b, sort));
  }, [evaluations, defaultFeasibilityThreshold, solvencyThreshold, spendFilter, sort]);

  /**
   * Highest-spend evaluation that still clears both policy gates.
   * Mirrors the household-facing ranker: hit the legacy floor, defend
   * against plans that run out of money, then maximize spend.
   */
  const bestByMaxSpend = useMemo(() => {
    let best: PolicyEvaluation | null = null;
    for (const ev of evaluations) {
      if (ev.outcome.bequestAttainmentRate < defaultFeasibilityThreshold) continue;
      if (ev.outcome.solventSuccessRate < solvencyThreshold) continue;
      if (!best) {
        best = ev;
        continue;
      }
      if (
        ev.policy.annualSpendTodayDollars >
        best.policy.annualSpendTodayDollars
      ) {
        best = ev;
      } else if (
        ev.policy.annualSpendTodayDollars ===
          best.policy.annualSpendTodayDollars &&
        ev.outcome.solventSuccessRate > best.outcome.solventSuccessRate
      ) {
        best = ev;
      } else if (
        ev.policy.annualSpendTodayDollars ===
          best.policy.annualSpendTodayDollars &&
        ev.outcome.solventSuccessRate === best.outcome.solventSuccessRate &&
        ev.outcome.bequestAttainmentRate > best.outcome.bequestAttainmentRate
      ) {
        best = ev;
      } else if (
        ev.policy.annualSpendTodayDollars ===
          best.policy.annualSpendTodayDollars &&
        ev.outcome.solventSuccessRate === best.outcome.solventSuccessRate &&
        ev.outcome.bequestAttainmentRate === best.outcome.bequestAttainmentRate &&
        ev.outcome.p50EndingWealthTodayDollars >
          best.outcome.p50EndingWealthTodayDollars
      ) {
        best = ev;
      }
    }
    return best;
  }, [evaluations, defaultFeasibilityThreshold, solvencyThreshold]);

  const visible = useMemo(() => {
    const base = showAll ? filtered : filtered.slice(0, rowLimit);
    // Pin bestByMaxSpend at the top if it isn't already in the visible
    // slice (common when the user sorts by feasibility desc and the
    // high-spend/lower-feasibility row is below the rowLimit cut).
    if (!bestByMaxSpend) return base;
    if (base.some((ev) => ev.id === bestByMaxSpend.id)) return base;
    return [bestByMaxSpend, ...base];
  }, [filtered, rowLimit, showAll, bestByMaxSpend]);

  // Whether to render at all. Local mode hides if there's no baseline /
  // no records. Cluster mode renders even when empty so the picker /
  // error state stay visible. The undo banner is its own reason to
  // render — even with no rows on screen, the user must be able to
  // revert a recent adoption.
  if (source === 'local' && (!baselineFingerprint || evaluations.length === 0)) {
    if (!clusterEnabled && !lastPolicyAdoption) return null;
    // Fall through to render the source toggle / undo banner.
  }

  // True total comes from the dispatcher (it knows the on-disk count
  // before any topN/minFeasibility slicing). When we're in local-IDB
  // mode we don't have that signal, so fall back to the array length.
  const totalEvaluated =
    source === 'cluster' ? evaluationCount : evaluations.length;
  const totalFeasible = filtered.length;

  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev.key !== key) {
        // First click on a new column picks the direction that puts the
        // "most interesting" rows on top: numeric metrics default to desc,
        // ages default to asc (younger = sooner).
        const direction =
          key === 'primarySs' || key === 'spouseSs' ? 'asc' : 'desc';
        return { key, direction };
      }
      return {
        key,
        direction: prev.direction === 'desc' ? 'asc' : 'desc',
      };
    });
  };

  const sortIndicator = (key: SortKey): string => {
    if (sort.key !== key) return '';
    return sort.direction === 'desc' ? ' ↓' : ' ↑';
  };

  const baselineMismatch =
    source === 'cluster' &&
    selectedSession &&
    baselineFingerprint &&
    selectedSession.manifest?.config?.baselineFingerprint !== baselineFingerprint;
  const legacyTargetMismatch =
    source === 'cluster' &&
    selectedSession &&
    legacyTargetTodayDollars != null &&
    legacyTargetTodayDollars > 0 &&
    selectedSession.manifest?.legacyTargetTodayDollars !== legacyTargetTodayDollars;

  // E.7 — plain-English explanation of the most recent adoption. Looks
  // up the adopted policy in the visible evaluations to enrich the
  // narrative with the bequest-attainment number; falls back to a
  // lever-only narrative if no matching evaluation is on hand (e.g. the
  // user switched corpus source after adopting). Memoized on the
  // adoption + the evaluations array so it doesn't recompute every render.
  const adoptionExplanation = useMemo(() => {
    if (!lastPolicyAdoption) return null;
    const adopted = lastPolicyAdoption.policy;
    const matched = evaluations.find(
      (e) =>
        e.policy.annualSpendTodayDollars === adopted.annualSpendTodayDollars &&
        e.policy.primarySocialSecurityClaimAge ===
          adopted.primarySocialSecurityClaimAge &&
        e.policy.spouseSocialSecurityClaimAge ===
          adopted.spouseSocialSecurityClaimAge &&
        e.policy.rothConversionAnnualCeiling ===
          adopted.rothConversionAnnualCeiling,
    );
    return explainAdoption(
      lastPolicyAdoption.previousData,
      adopted,
      matched
        ? { bequestAttainmentRate: matched.outcome.bequestAttainmentRate }
        : null,
    );
  }, [lastPolicyAdoption, evaluations]);

  return (
    <div className="mt-4 rounded-2xl border border-stone-200 bg-white/80 p-4 text-sm text-stone-700 shadow-sm">
      {lastPolicyAdoption && (
        <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900">
          {/* Top row: dense one-line summary + actions. The household
              that just clicked Adopt can scan this and move on. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-semibold">Adopted:</span>{' '}
              {lastPolicyAdoption.summary}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={undoLastPolicyAdoption}
                className="rounded-full bg-white px-3 py-0.5 text-[11px] font-semibold text-emerald-800 ring-1 ring-emerald-300 transition hover:bg-emerald-100"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={clearLastPolicyAdoption}
                aria-label="Dismiss adoption banner"
                className="rounded-full px-2 py-0.5 text-[14px] leading-none text-emerald-700 transition hover:bg-emerald-100"
              >
                ×
              </button>
            </div>
          </div>
          {/* E.7 — plain-English narrative under the headline. Three
              short sentences max so it stays scannable; falls back to
              just the headline + detail when no evaluation is on hand
              for the feasibility note. */}
          {adoptionExplanation && (
            <div className="mt-1.5 space-y-0.5 text-[12px] text-emerald-900">
              <p>{adoptionExplanation.headline}</p>
              {adoptionExplanation.detail && (
                <p className="text-emerald-800">{adoptionExplanation.detail}</p>
              )}
              {adoptionExplanation.feasibilityNote && (
                <p className="text-[11px] text-emerald-700">
                  {adoptionExplanation.feasibilityNote}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {/* E.5 — sensitivity check sits directly below the adoption banner.
          Only renders when (a) the household has just adopted a policy
          (so there's something to test sensitivity around) and (b) the
          parent passed the controls needed to launch a cluster session. */}
      {lastPolicyAdoption && sensitivityControls && baselineFingerprint && (
        <SensitivityPanel
          adoptedPolicy={lastPolicyAdoption.policy}
          baseline={sensitivityControls.baseline}
          baselineFingerprint={baselineFingerprint}
          assumptions={sensitivityControls.assumptions}
          legacyTargetTodayDollars={sensitivityControls.legacyTargetTodayDollars}
          dispatcherUrl={dispatcherUrl ?? null}
        />
      )}
      {/* E.6 — stress test sits directly below sensitivity. Same gate
          (post-adoption + sensitivityControls present) but runs INLINE
          on the main thread; no cluster needed. The two panels answer
          adjacent questions: sensitivity = "what if I bump one knob?",
          stress = "what if the world goes badly?". */}
      {lastPolicyAdoption && sensitivityControls && baselineFingerprint && (
        <StressTestPanel
          adoptedPolicy={lastPolicyAdoption.policy}
          baseline={sensitivityControls.baseline}
          assumptions={sensitivityControls.assumptions}
          legacyTargetTodayDollars={sensitivityControls.legacyTargetTodayDollars}
        />
      )}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
            Mined Plan Candidates
          </p>
          <p className="mt-0.5 text-[12px] text-stone-500">
            {totalFeasible.toLocaleString()} candidates clear gates of{' '}
            {totalEvaluated.toLocaleString()} evaluated · sorted by{' '}
            {sort.key === 'spend'
              ? 'highest annual spend'
              : sort.key === 'bequestP50'
                ? 'highest median bequest'
                : sort.key === 'bequestP10'
                  ? 'highest worst-case bequest'
                  : sort.key === 'feasibility'
                    ? 'highest legacy attainment'
                    : sort.key === 'primarySs'
                      ? 'primary SS claim age'
                      : sort.key === 'spouseSs'
                        ? 'spouse SS claim age'
                        : 'Roth conversion ceiling'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Source toggle intentionally hidden — corpus storage location
           *  shouldn't be a household-facing concern. The default below
           *  picks Cluster when connected, Local otherwise. If a power
           *  user genuinely needs to inspect a different backend, set
           *  `?source=local` via the URL or expose this conditionally
           *  on a debug flag. For now the household just sees their
           *  results. */}
          <div className="flex items-center gap-2">
            <label className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
              Spend
            </label>
            <select
              value={spendFilter ?? ''}
              onChange={(e) =>
                setSpendFilter(
                  e.target.value ? Number.parseInt(e.target.value, 10) : null,
                )
              }
              className="rounded-md border border-stone-200 bg-white px-2 py-1 text-[12px] font-semibold text-stone-700"
            >
              <option value="">All</option>
              {spendLevels.map((level) => (
                <option key={level} value={level}>
                  {formatCurrency(level)}
                </option>
              ))}
            </select>
            {spendRangeLabel && (
              <span className="text-[11px] text-stone-500">
                {spendRangeLabel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] font-medium uppercase tracking-wider text-stone-500">
              Min solvency
            </label>
            <input
              type="range"
              min={0.5}
              max={0.99}
              step={0.01}
              value={solvencyThreshold}
              onChange={(e) =>
                setSolvencyThreshold(Number.parseFloat(e.target.value))
              }
              className="h-1 w-32 cursor-pointer accent-emerald-600"
            />
            <span className="w-10 text-right text-[12px] font-semibold tabular-nums text-stone-700">
              {formatPct(solvencyThreshold)}
            </span>
            <span className="text-[11px] font-medium text-stone-500">
              Legacy floor {formatPct(defaultFeasibilityThreshold)}
            </span>
          </div>
        </div>
      </div>

      {/* Session picker hidden — auto-picks the most recent matching
       *  session by baseline fingerprint (see effect above). The
       *  household never needs to think about which "run" to look at;
       *  the system picks the right one. The baselineMismatch banner
       *  below stays — that's the one piece of session metadata that
       *  matters to the user (when their plan has drifted since the
       *  last mine ran). */}
      {source === 'cluster' && (clusterError || baselineMismatch || legacyTargetMismatch) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {clusterError && (
            <span className="text-[11px] text-rose-600">{clusterError}</span>
          )}
          {baselineMismatch && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
              Baseline differs from current plan — diff columns may not be
              meaningful
            </span>
          )}
          {legacyTargetMismatch && (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-800">
              Mine used {formatCurrency(selectedSession.manifest?.legacyTargetTodayDollars ?? 0)} legacy target — remine for {formatCurrency(legacyTargetTodayDollars)}
            </span>
          )}
        </div>
      )}

      {totalEvaluated === 0 ? (
        <p className="rounded-md bg-stone-50 px-3 py-2 text-[12px] text-stone-600">
          {source === 'cluster'
            ? clusterError
              ? `Couldn't reach the dispatcher — ${clusterError}`
              : 'No evaluations to show. Pick a different session above, or run a mining session via the controller CLI.'
            : 'No local evaluations yet. Start mining from the status card or switch to Cluster.'}
        </p>
      ) : totalFeasible === 0 ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          No candidates clear the {formatPct(solvencyThreshold)} solvency
          floor and {formatPct(defaultFeasibilityThreshold)} legacy floor.
          Lower the solvency threshold or wait for more policies to be mined.
        </p>
      ) : (
        <>
          {/* E.4 — frontier scatter sits ABOVE the ranked table so the
              household reads the chart's gestalt first, then drills into
              specific rows. Click-to-adopt routes through the same
              modal as the row buttons. */}
          <PolicyFrontierChart
            evaluations={evaluations}
            currentPlan={
              currentPlan?.annualSpendTodayDollars != null &&
              currentPlan?.p50EndingWealthTodayDollars != null
                ? {
                    annualSpendTodayDollars: currentPlan.annualSpendTodayDollars,
                    p50EndingWealthTodayDollars:
                      currentPlan.p50EndingWealthTodayDollars,
                  }
                : undefined
            }
            adoptedPolicy={lastPolicyAdoption?.policy ?? null}
            defaultFeasibilityThreshold={defaultFeasibilityThreshold}
            minSolvencyThreshold={solvencyThreshold}
            onAdoptPolicy={(policy) => setAdoptingPolicy(policy)}
          />
        <div className="mt-4 -mx-4 overflow-x-auto px-4">
          <table className="w-full text-left text-[12px] tabular-nums">
            <thead>
              <tr className="border-b border-stone-200 text-[11px] font-medium uppercase tracking-wider text-stone-500">
                <th
                  className="cursor-pointer py-2 pr-3 hover:text-stone-700"
                  onClick={() => toggleSort('spend')}
                >
                  Spend / yr{sortIndicator('spend')}
                </th>
                <th
                  className="cursor-pointer py-2 pr-3 hover:text-stone-700"
                  onClick={() => toggleSort('primarySs')}
                >
                  Pri SS{sortIndicator('primarySs')}
                </th>
                <th
                  className="cursor-pointer py-2 pr-3 hover:text-stone-700"
                  onClick={() => toggleSort('spouseSs')}
                >
                  Sp SS{sortIndicator('spouseSs')}
                </th>
                <th
                  className="cursor-pointer py-2 pr-3 hover:text-stone-700"
                  onClick={() => toggleSort('roth')}
                >
                  Roth cap{sortIndicator('roth')}
                </th>
                <th
                  className="cursor-pointer py-2 pr-3 hover:text-stone-700"
                  onClick={() => toggleSort('feasibility')}
                  title="% of stochastic trials where the household ends with at least the legacy target"
                >
                  Hits legacy{sortIndicator('feasibility')}
                </th>
                <th
                  className="cursor-pointer py-2 pr-3 hover:text-stone-700"
                  onClick={() => toggleSort('solvent')}
                  title="% of stochastic trials where the household never runs out of money during life"
                >
                  Solvent{sortIndicator('solvent')}
                </th>
                <th
                  className="cursor-pointer py-2 pr-3 hover:text-stone-700"
                  onClick={() => toggleSort('bequestP50')}
                >
                  Bequest P50{sortIndicator('bequestP50')}
                </th>
                <th
                  className="cursor-pointer py-2 pr-3 hover:text-stone-700"
                  onClick={() => toggleSort('bequestP10')}
                >
                  Bequest P10{sortIndicator('bequestP10')}
                </th>
                {currentPlan ? (
                  <>
                    <th className="py-2 pr-3">Δ Spend</th>
                    <th className="py-2 pr-3">Δ Bequest P50</th>
                    <th className="py-2 pr-3">vs Current</th>
                  </>
                ) : null}
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((ev) => {
                const spendDelta = currentPlan
                  ? ev.policy.annualSpendTodayDollars -
                    currentPlan.annualSpendTodayDollars
                  : null;
                const bequestDelta =
                  currentPlan && currentPlan.p50EndingWealthTodayDollars != null
                    ? ev.outcome.p50EndingWealthTodayDollars -
                      currentPlan.p50EndingWealthTodayDollars
                    : null;
                const spendDeltaFmt =
                  spendDelta != null
                    ? formatDelta(spendDelta, formatCurrency)
                    : null;
                const bequestDeltaFmt =
                  bequestDelta != null
                    ? formatDelta(bequestDelta, formatCurrency)
                    : null;
                const isHighestSpendPinned =
                  bestByMaxSpend != null && ev.id === bestByMaxSpend.id;
                const solventPct = ev.outcome.solventSuccessRate;
                return (
                  <tr
                    key={ev.id}
                    className={`border-b border-stone-100 last:border-b-0 hover:bg-stone-50 ${
                      isHighestSpendPinned ? 'bg-amber-50/50' : ''
                    }`}
                  >
                    <td className="py-2 pr-3 font-semibold text-stone-900">
                      {isHighestSpendPinned && (
                        <span
                          className="mr-1.5 inline-block rounded bg-amber-500 px-1 py-0.5 text-[9px] font-bold text-white"
                          title="Highest-spend policy that still clears the legacy and solvency floors"
                        >
                          ★ MAX
                        </span>
                      )}
                      {formatCurrency(ev.policy.annualSpendTodayDollars)}
                    </td>
                    <td className="py-2 pr-3">
                      {ageOrDash(ev.policy.primarySocialSecurityClaimAge)}
                    </td>
                    <td className="py-2 pr-3">
                      {ageOrDash(ev.policy.spouseSocialSecurityClaimAge)}
                    </td>
                    <td className="py-2 pr-3">
                      {formatCurrency(ev.policy.rothConversionAnnualCeiling)}
                    </td>
                    <td className="py-2 pr-3 font-semibold text-emerald-700">
                      {formatPct(ev.outcome.bequestAttainmentRate)}
                    </td>
                    <td
                      className={`py-2 pr-3 font-semibold ${
                        solventPct >= 0.95
                          ? 'text-emerald-700'
                          : solventPct >= 0.85
                          ? 'text-amber-700'
                          : 'text-rose-600'
                      }`}
                    >
                      {formatPct(solventPct)}
                    </td>
                    <td className="py-2 pr-3">
                      {formatCurrency(ev.outcome.p50EndingWealthTodayDollars)}
                    </td>
                    <td className="py-2 pr-3 text-stone-500">
                      {formatCurrency(ev.outcome.p10EndingWealthTodayDollars)}
                    </td>
                    {currentPlan ? (
                      <>
                        <td
                          className={`py-2 pr-3 ${
                            spendDeltaFmt
                              ? deltaClass(spendDeltaFmt.tone)
                              : 'text-stone-400'
                          }`}
                        >
                          {spendDeltaFmt ? spendDeltaFmt.text : '—'}
                        </td>
                        <td
                          className={`py-2 pr-3 ${
                            bequestDeltaFmt
                              ? deltaClass(bequestDeltaFmt.tone)
                              : 'text-stone-400'
                          }`}
                        >
                          {bequestDeltaFmt ? bequestDeltaFmt.text : '—'}
                        </td>
                        <td className="py-2 pr-3 text-[11px] text-stone-500">
                          {policyDiffSummary(ev.policy, currentPlan)}
                        </td>
                      </>
                    ) : null}
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setAdoptingPolicy(ev.policy)}
                        className="rounded-full bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                      >
                        Adopt
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}

      {totalFeasible > rowLimit && (
        <div className="mt-3 flex items-center justify-between text-[12px] text-stone-500">
          <span>
            Showing {visible.length.toLocaleString()} of{' '}
            {totalFeasible.toLocaleString()} feasible candidates
          </span>
          <button
            type="button"
            onClick={() => setShowAll((prev) => !prev)}
            className="rounded-full bg-stone-100 px-3 py-1 text-[11px] font-semibold text-stone-700 transition hover:bg-stone-200"
          >
            {showAll ? `Show top ${rowLimit}` : 'Show all'}
          </button>
        </div>
      )}
      {adoptingPolicy && (
        <PolicyAdoptionModal
          policy={adoptingPolicy}
          currentData={currentSeed}
          baselineMismatch={!!baselineMismatch}
          onCancel={() => setAdoptingPolicy(null)}
          onConfirm={() => {
            adoptMinedPolicy(adoptingPolicy);
            setAdoptingPolicy(null);
          }}
        />
      )}
    </div>
  );
}
