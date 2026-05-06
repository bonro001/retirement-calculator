/**
 * `useRecommendedPolicy` — the cockpit's headline read against the
 * mining corpus. Replaces the cockpit's per-render bisection chain
 * (SS optimizer + spend solver + Roth optimizer) with a single lookup.
 *
 * Returns the top-1 record under `LEGACY_FIRST_LEXICOGRAPHIC` plus
 * enough state for the cockpit to render its hard-gate empty state
 * ("Run your first mine") when no corpus exists for the current plan.
 *
 * Source-of-truth design: this hook is the SINGLE entry point both
 * the cockpit's TRUST card and any future "best plan" UI consume.
 * Adding a new screen that wants to cite the recommended policy →
 * call this hook.
 */

import { useEffect, useMemo, useState } from 'react';
import type { MarketAssumptions, SeedData } from './types';
import type { Policy, PolicyEvaluation } from './policy-miner-types';
import { buildEvaluationFingerprint } from './evaluation-fingerprint';
import { loadEvaluationsForBaseline } from './policy-mining-corpus';
import {
  loadClusterEvaluations,
  loadClusterSessions,
} from './policy-mining-cluster';
import { POLICY_MINER_ENGINE_VERSION } from './policy-miner-types';
import { POLICY_MINING_TRIAL_COUNT } from './policy-mining-config';
import {
  bestPolicy,
  LEGACY_ATTAINMENT_FLOOR,
  LEGACY_FIRST_LEXICOGRAPHIC,
  SOLVENCY_DEFENSE_FLOOR,
} from './policy-ranker';
import { adoptedSeedMatchesPolicy } from './policy-adoption';
import type { PolicyAdoptionUndo } from './store';

export type CorpusState =
  | 'loading'
  | 'no-corpus' // no records for this plan fingerprint
  | 'stale-corpus' // records exist but for a different fingerprint
  | 'fresh';

export interface RecommendedPolicy {
  policy: PolicyEvaluation | null;
  state: CorpusState;
  /** The plan fingerprint the lookup matched against. Null when offline /
   *  before the first poll completes. */
  fingerprint: string | null;
  /** Total evaluation count in the corpus (gate-passing or not). Useful
   *  for the empty-state copy and for "X feasible of Y mined" diagnostics. */
  evaluationCount: number;
  /** When the corpus was last polled, ISO 8601. Cockpit can show "as of N
   *  minutes ago" if the user wants to know how fresh the recommendation is. */
  lastPolledIso: string | null;
}

const POLL_INTERVAL_MS = 30_000;
const RECOMMENDED_POLICY_LS_KEY =
  'retirement-calc:recommended-policy-cache:v1';

interface CachedEntry {
  fingerprint: string;
  policy: PolicyEvaluation;
  evaluationCount: number;
  cachedAtIso: string;
}

function readCachedEntry(): CachedEntry | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage?.getItem(RECOMMENDED_POLICY_LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedEntry;
  } catch {
    return null;
  }
}

function writeCachedEntry(entry: CachedEntry | null): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!entry) {
      window.localStorage.removeItem(RECOMMENDED_POLICY_LS_KEY);
      return;
    }
    window.localStorage.setItem(
      RECOMMENDED_POLICY_LS_KEY,
      JSON.stringify(entry),
    );
  } catch {
    // localStorage quota / private browsing — non-fatal.
  }
}

function policiesMatch(a: Policy | null | undefined, b: Policy | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.annualSpendTodayDollars === b.annualSpendTodayDollars &&
    a.primarySocialSecurityClaimAge === b.primarySocialSecurityClaimAge &&
    a.spouseSocialSecurityClaimAge === b.spouseSocialSecurityClaimAge &&
    a.rothConversionAnnualCeiling === b.rothConversionAnnualCeiling &&
    (a.withdrawalRule ?? 'tax_bracket_waterfall') ===
      (b.withdrawalRule ?? 'tax_bracket_waterfall')
  );
}

function cacheMatchesCurrentAdoption(
  cached: CachedEntry | null,
  data: SeedData | null,
  adoption: PolicyAdoptionUndo | null | undefined,
): boolean {
  if (!cached || !data || !adoption) return false;
  if (!policiesMatch(cached.policy.policy, adoption.policy)) return false;
  return adoptionMatchesCurrentData(data, adoption);
}

function adoptionMatchesCurrentData(
  data: SeedData | null,
  adoption: PolicyAdoptionUndo | null | undefined,
): boolean {
  if (!data || !adoption) return false;
  return adoptedSeedMatchesPolicy(
    data,
    adoption.previousAppliedData,
    adoption.policy,
  );
}

/**
 * Fetch the policy corpus from whichever source is available — cluster
 * dispatcher first, falling back to local IDB. Mirrors the source-toggle
 * logic the mining results table uses.
 */
async function fetchCorpus(
  fingerprint: string,
  dispatcherUrl: string | null,
): Promise<PolicyEvaluation[] | null> {
  if (dispatcherUrl) {
    try {
      const sessions = await loadClusterSessions(dispatcherUrl);
      const match = sessions.find(
        (s) => s.manifest?.config?.baselineFingerprint === fingerprint,
      );
      if (match) {
        const payload = await loadClusterEvaluations(
          dispatcherUrl,
          match.sessionId,
          {
            topN: 0,
            minFeasibility: LEGACY_ATTAINMENT_FLOOR,
            minSolvency: SOLVENCY_DEFENSE_FLOOR,
          },
        );
        if (payload?.evaluations?.length) return payload.evaluations;
      }
    } catch {
      // Cluster unreachable — fall through to local lookup.
    }
  }
  try {
    const local = await loadEvaluationsForBaseline(
      fingerprint,
      POLICY_MINER_ENGINE_VERSION,
    );
    return local.length > 0 ? local : null;
  } catch {
    return null;
  }
}

export function useRecommendedPolicy(
  data: SeedData | null,
  assumptions: MarketAssumptions | null,
  selectedStressors: string[],
  selectedResponses: string[],
  dispatcherUrl: string | null,
  adoption: PolicyAdoptionUndo | null = null,
): RecommendedPolicy {
  const fingerprint = useMemo(() => {
    if (!data || !assumptions) return null;
    try {
      // Use the SAME suffixed fingerprint MiningScreen uses to register
      // sessions. Without the suffix, the cockpit
      // and the mining screen would look at different cluster sessions
      // for the same household plan and the cockpit would never see
      // the corpus produced by a mine.
      const base = buildEvaluationFingerprint({
        data,
        assumptions,
        selectedStressors,
        selectedResponses,
      });
      return `${base}|trials=${POLICY_MINING_TRIAL_COUNT}|fpv1`;
    } catch {
      return null;
    }
  }, [data, assumptions, selectedStressors, selectedResponses]);

  // Hydrate from localStorage so page refresh shows the recommendation
  // instantly while a fresh poll runs in the background.
  const [cached, setCached] = useState<CachedEntry | null>(() =>
    readCachedEntry(),
  );
  const [state, setState] = useState<CorpusState>(() =>
    readCachedEntry() ? 'fresh' : 'loading',
  );
  const [evaluationCount, setEvaluationCount] = useState<number>(
    cached?.evaluationCount ?? 0,
  );
  const [lastPolledIso, setLastPolledIso] = useState<string | null>(
    cached?.cachedAtIso ?? null,
  );

  useEffect(() => {
    if (!fingerprint) {
      setState('loading');
      return undefined;
    }
    let cancelled = false;
    const tick = async () => {
      const evals = await fetchCorpus(fingerprint, dispatcherUrl);
      if (cancelled) return;
      const nowIso = new Date().toISOString();
      setLastPolledIso(nowIso);
      if (!evals || evals.length === 0) {
        // Distinguish "no corpus at all" from "corpus exists for a
        // different fingerprint" — both produce no policy, but the
        // empty-state copy differs (run a mine vs re-run because the
        // plan changed).
        const stale = readCachedEntry();
        if (stale && stale.fingerprint !== fingerprint) {
          setCached(stale);
          setState('stale-corpus');
          setEvaluationCount(stale.evaluationCount);
        } else {
          setCached(null);
          setState('no-corpus');
          setEvaluationCount(0);
          writeCachedEntry(null);
        }
        return;
      }
      const top = bestPolicy(evals, LEGACY_FIRST_LEXICOGRAPHIC);
      if (!top) {
        // Corpus exists but no record clears the gates. Treat as
        // no-corpus from the cockpit's perspective — there's no
        // recommendation to display.
        setCached(null);
        setState('no-corpus');
        setEvaluationCount(evals.length);
        writeCachedEntry(null);
        return;
      }
      const entry: CachedEntry = {
        fingerprint,
        policy: top,
        evaluationCount: evals.length,
        cachedAtIso: nowIso,
      };
      setCached(entry);
      setState('fresh');
      setEvaluationCount(evals.length);
      writeCachedEntry(entry);
    };
    void tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [fingerprint, dispatcherUrl]);

  // Auto-detect "stale-corpus": cached fingerprint differs from the
  // one we just computed. The poll above will refine this to no-corpus
  // / fresh once the network call returns; this branch shows the
  // stale state immediately for the first render so the cockpit can
  // surface a "your plan changed, re-mine" banner.
  const effectiveState: CorpusState = (() => {
    if (!fingerprint) return 'loading';
    if (
      adoption?.evaluation &&
      policiesMatch(adoption.evaluation.policy, adoption.policy) &&
      adoptionMatchesCurrentData(data, adoption)
    ) {
      return 'fresh';
    }
    if (
      state === 'stale-corpus' &&
      cacheMatchesCurrentAdoption(cached, data, adoption)
    ) {
      return 'fresh';
    }
    if (state === 'fresh' && cached?.fingerprint !== fingerprint) {
      if (cacheMatchesCurrentAdoption(cached, data, adoption)) {
        return 'fresh';
      }
      return 'stale-corpus';
    }
    return state;
  })();
  const shouldUseAdoptionCache =
    effectiveState === 'fresh' &&
    cached?.fingerprint !== fingerprint &&
    cacheMatchesCurrentAdoption(cached, data, adoption);
  const shouldUseAdoptionEvaluation =
    effectiveState === 'fresh' &&
    adoption?.evaluation &&
    policiesMatch(adoption.evaluation.policy, adoption.policy) &&
    adoptionMatchesCurrentData(data, adoption);
  const policyFromCache =
    effectiveState === 'fresh' &&
    cached &&
    (cached.fingerprint === fingerprint || shouldUseAdoptionCache)
      ? cached.policy
      : null;

  return {
    policy:
      shouldUseAdoptionEvaluation
        ? adoption.evaluation!
        : policyFromCache,
    state: effectiveState,
    fingerprint,
    evaluationCount,
    lastPolledIso,
  };
}
