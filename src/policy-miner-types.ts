/**
 * Policy Miner — type contracts for the offline policy-search system.
 *
 * Why "mining"? The household's real question — "what's the best path that
 * leaves at least $X with at least P% confidence?" — is a multi-dimensional
 * search problem. The spend-solver inverts ONE dimension (annual spend) at
 * a fixed allocation/SS-claim/conversion policy. Adding more dimensions
 * (SS claim age, Roth conversion schedule, glidepath) breaks the monotonicity
 * inversion needs. So we brute-force forward: enumerate policies, run the
 * full Monte Carlo on each, keep the feasible ones, rank.
 *
 * Like bitcoin mining: lots of independent work units, each cheap-to-verify,
 * runs continuously in the background, the corpus grows over time. Unlike
 * bitcoin: the work is useful — every accepted record is a candidate plan
 * the household could actually adopt.
 *
 * This file defines the on-disk + in-memory shapes. The miner itself lives
 * in `policy-miner.ts`; the IndexedDB store in `policy-mining-corpus.ts`;
 * the candidate generator in `policy-axis-enumerator.ts`.
 */

/**
 * Engine version stamp written into every PolicyEvaluation. Bump this
 * whenever a Monte Carlo or post-processing change would alter the
 * outcome of an existing record. The corpus reader filters by
 * `[baselineFingerprint, engineVersion]` so old records become invisible
 * (but stay on disk for archaeology) when this changes.
 *
 * Format: `policy-miner-vN-engineYYYY-MM` so a glance tells you when a
 * given record's lineage was minted.
 */
export const POLICY_MINER_ENGINE_VERSION = 'policy-miner-v2-2026-05-01';

/**
 * The four axes the V1 miner sweeps. Adding a new axis means: (1) extend
 * this type, (2) extend `PolicyAxes` below with the corresponding option
 * list, (3) extend the enumerator's cartesian product, (4) extend
 * `applyPolicyToSeed` in the miner so the engine actually sees the change.
 *
 * Why these four? They're the levers a household can actually pull and
 * that meaningfully change long-run outcomes:
 *  - annualSpendTodayDollars: the dial households re-touch every year
 *  - primarySocialSecurityClaimAge: one-shot, irreversible after age 70
 *  - spouseSocialSecurityClaimAge: same, second earner
 *  - rothConversionAnnualCeiling: the bracket-fill knob during the
 *    pre-RMD window
 *
 * Asset allocation glidepath, gifting schedule, and sale-of-home timing
 * are explicit V2 candidates — not in the V1 enumerator to keep the corpus
 * size tractable (~7,776 policies fits in <500MB IndexedDB).
 */
export interface Policy {
  /** Constant-real annual spend the engine should hold in retirement. */
  annualSpendTodayDollars: number;
  /** Age the primary earner files for SS (62..70). Supports 6-month
   *  resolution (e.g., 67.5) — engine pays partial-year benefit at the
   *  year of crossing. */
  primarySocialSecurityClaimAge: number;
  /** Age the spouse files for SS (62..70). null when the household has no spouse SS record. */
  spouseSocialSecurityClaimAge: number | null;
  /** Annual cap on Roth conversions during the pre-RMD bracket-fill window (today $). */
  rothConversionAnnualCeiling: number;
  /** Withdrawal rule — bucket order and split logic. Defaults to
   *  `tax_bracket_waterfall` for backward compatibility with corpora
   *  written before the axis was added. */
  withdrawalRule?: import('./types').WithdrawalRule;
}

/**
 * Specification of the candidate space the enumerator should produce.
 * Each field is the explicit set of values to try along that axis. The
 * enumerator emits the full cartesian product.
 *
 * V1 default sizes (configured in policy-axis-enumerator.ts):
 *   spend: 16 levels × primarySS: 9 ages × spouseSS: 9 ages × roth: 6 caps
 *   = 7,776 policies. At ~3-5s each on M4 mini single-threaded, that's
 *   ~6-11 hours unattended. Phase B parallelization brings it to ~1 hour.
 */
export interface PolicyAxes {
  annualSpendTodayDollars: number[];
  primarySocialSecurityClaimAge: number[];
  spouseSocialSecurityClaimAge: number[] | null;
  rothConversionAnnualCeiling: number[];
  /** Withdrawal rules to mine. Optional for backward compatibility;
   *  callers that omit this default to tax_bracket_waterfall only
   *  (preserving pre-2026-05-01 corpus behavior). */
  withdrawalRule?: import('./types').WithdrawalRule[];
}

/**
 * What the engine reports back for a single policy run. Stored in the
 * corpus indexed by `id` (a stable hash of the policy + baseline) so we
 * can dedupe across re-runs and detect "this exact policy was evaluated
 * before" without re-simulating.
 *
 * The numbers we keep are the ones the ranking layer needs. We do NOT
 * store full per-trial yearly traces — that would blow past IndexedDB
 * quota in a few thousand records. If a household drills into a specific
 * policy from the results table, the UI re-runs that one policy on demand
 * to show the full trajectory.
 *
 * Distribution-readiness: `evaluatedByNodeId` stamps which machine
 * produced the record. Today it's always "local"; in a future
 * multi-host fleet (the user has several Mac minis), each host writes
 * its own value and a sync layer merges corpora across hosts. The
 * deterministic `id` field guarantees that two hosts evaluating the
 * same policy land on the same record.
 */
export interface PolicyEvaluation {
  /**
   * Identity of the host that ran this evaluation. "local" for the
   * in-process miner; hostname (or assigned slug like "mini-attic" /
   * "mini-studio") for distributed nodes. Used by the ranking layer to
   * surface cross-host confirmation and by the sync layer for audit.
   */
  evaluatedByNodeId: string;
  /** Stable hash of `policy + baselineFingerprint + engineVersion`. */
  id: string;
  /**
   * Hash of the SeedData the policy was evaluated against. Used as the
   * primary corpus partition key — when SeedData changes (new salary,
   * new account balance, edited goal), records from the old baseline
   * are no longer comparable and get filtered out (or migrated, V2).
   */
  baselineFingerprint: string;
  /**
   * Engine code version (semver-ish string from package.json + git SHA).
   * Bumping this invalidates the entire corpus — we don't trust numbers
   * from a different engine build to be comparable.
   */
  engineVersion: string;
  /** When this evaluation finished, ISO-8601. */
  evaluatedAtIso: string;
  /** The policy that was tested. Copied here so a record is self-describing. */
  policy: Policy;
  /** Outcome metrics — the ranking layer reads these. */
  outcome: {
    /** P(ending wealth > 0) — the historical "success rate". */
    solventSuccessRate: number;
    /** P(ending wealth >= North Star) — the bequest-attainment rate. */
    bequestAttainmentRate: number;
    /** Cemetery percentiles in today's dollars. */
    p10EndingWealthTodayDollars: number;
    p25EndingWealthTodayDollars: number;
    p50EndingWealthTodayDollars: number;
    p75EndingWealthTodayDollars: number;
    p90EndingWealthTodayDollars: number;
    /** Median lifetime spending across all trials, today's dollars. */
    medianLifetimeSpendTodayDollars: number;
    /** Coefficient-of-variation of annual spend across the median path. Lower = smoother. */
    medianSpendVolatility: number;
    /** Median total federal income tax paid across all trials, today's dollars. */
    medianLifetimeFederalTaxTodayDollars: number;
    /** Fraction of trials that hit at least one IRMAA bracket. */
    irmaaExposureRate: number;
  };
  /** How long this single policy took to evaluate, milliseconds. */
  evaluationDurationMs: number;
}

/**
 * Live mining progress — emitted by the miner to the UI status panel.
 * Updated after each policy completes (or batch, depending on Phase A vs
 * B). Persisted to IndexedDB on every update so the panel survives a
 * page reload.
 */
export interface MiningStats {
  /** When this mining session started, ISO-8601. */
  sessionStartedAtIso: string;
  /** Total candidates the enumerator emitted for this session. */
  totalPolicies: number;
  /** Candidates evaluated so far. */
  policiesEvaluated: number;
  /** Candidates that met the feasibility filter (e.g. attainment >= 0.70). */
  feasiblePolicies: number;
  /**
   * Candidates the cluster gave up on after exhausting per-policy retry
   * attempts (D.5 dead-letter). Always 0 for the legacy in-process miner
   * since it has no retry concept. Surfaced in the UI so a poisoned
   * baseline is visible rather than silently underreporting evaluations.
   */
  droppedPolicies: number;
  /** Rolling mean ms per policy over the last N completions. */
  meanMsPerPolicy: number;
  /** Rolling p95 ms per policy. */
  p95MsPerPolicy: number;
  /** Estimated time-to-completion in milliseconds. */
  estimatedRemainingMs: number;
  /**
   * Best policy found so far. V1 ranking: feasibility-passing, then
   * highest annual spend, then highest p50 today-dollar bequest as
   * tiebreaker. The tablestakes spend floor is enforced upstream by
   * the axis enumerator so every feasible candidate is already livable.
   * Null until the first feasible record arrives.
   *
   * (V2 will extend this with tax minimization and spend smoothness
   * inside the same `isBetterFeasibleCandidate` comparator.)
   */
  bestPolicyId: string | null;
  /**
   * Phase 2.C two-stage screening telemetry. Always 0 when coarseStage
   * is disabled. When enabled, set after the coarse pass completes:
   *   - coarseEvaluated: total candidates that went through the coarse pass
   *   - coarseScreenedOut: candidates that didn't survive the coarse cut
   * `policiesEvaluated` continues to count fine-pass completions only,
   * so existing UI / consumers see no behavior change. The two coarse
   * fields are extra signal for the status panel ("evaluated 7,776 at
   * N=200, kept 1,944 for full evaluation").
   */
  coarseEvaluated: number;
  coarseScreenedOut: number;
  /** Whether the miner is currently running, paused, or stopped. */
  state: 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'error';
  /** Last error message if state === 'error'. */
  lastError: string | null;
}

/**
 * A batch of policy candidates handed to a worker for evaluation.
 *
 * The unit of distribution. Today the in-process miner pulls one of these
 * from the local enumerator and runs it on a Web Worker. Tomorrow an
 * HTTP dispatcher hands the same shape out to a remote Mac mini, which
 * runs the same engine code locally and posts back a `MiningJobResult`.
 *
 * Batching matters: per-policy IPC (postMessage / HTTP roundtrip) would
 * dominate at sub-second policy times. Default V1 batch size is 4-8
 * policies — enough to amortize overhead, small enough that cancellation
 * still feels responsive (you lose at most one batch worth of work).
 *
 * The batch is self-contained: it carries the SeedData baseline + market
 * assumptions + engine version stamp. A receiving host needs nothing
 * else from the dispatcher to evaluate.
 */
export interface MiningJobBatch {
  /** Globally unique batch id (uuid). The result echoes this back. */
  batchId: string;
  /**
   * Hash of the SeedData baseline this batch is for. The receiving host
   * reconstructs SeedData from `seedDataPayload` below; this fingerprint
   * is the audit check that no payload corruption occurred in transit.
   */
  baselineFingerprint: string;
  /** Engine version the dispatcher expects. Receiving host MUST match or refuse. */
  engineVersion: string;
  /**
   * Serialized SeedData. Kept as `unknown` here so the type module stays
   * free of the SeedData shape; the miner casts at use site. Sent over
   * the wire as JSON.
   */
  seedDataPayload: unknown;
  /** Serialized MarketAssumptions. Same reasoning as `seedDataPayload`. */
  marketAssumptionsPayload: unknown;
  /** The candidate policies in this batch — the receiver evaluates each one. */
  policies: Policy[];
  /**
   * Trial count to run per policy. Today the dispatcher fixes this; later
   * the dispatcher can hand small batches a high trial count for
   * confirmation runs and large batches a small trial count for
   * exploration.
   */
  trialCount: number;
}

/**
 * What a worker returns after processing a `MiningJobBatch`. Symmetric
 * to the request shape, includes per-policy evaluations plus telemetry
 * about which node ran it and how long it took. The dispatcher feeds
 * these straight into the corpus.
 */
export interface MiningJobResult {
  /** Echoes `MiningJobBatch.batchId`. */
  batchId: string;
  /** Identity of the host that produced this result. Stamped onto each evaluation. */
  evaluatedByNodeId: string;
  /**
   * How long this batch sat accepted by the host before local workers
   * began evaluating it. Populated by Node hosts that prefetch batches.
   */
  hostQueueDelayMs?: number;
  /** Wall-clock duration of the entire batch, milliseconds. */
  batchDurationMs: number;
  /** One evaluation per input policy, in input order. */
  evaluations: PolicyEvaluation[];
  /** Optional runtime-shadow telemetry, populated by Node hosts running shadow engines. */
  shadowStats?: PolicyMinerShadowStats;
  /**
   * If the batch failed mid-flight, the partial results so far plus a
   * reason. Lets the dispatcher retry the missing policies on another
   * node rather than re-running the whole batch.
   */
  partialFailure: {
    completedPolicyIds: string[];
    reason: string;
  } | null;
}

export interface PolicyMinerShadowStats {
  runtime:
    | 'rust-shadow'
    | 'rust-dry-run'
    | 'rust-native-shadow'
    | 'rust-native-compact-shadow'
    | 'rust-native-compact';
  evaluated: number;
  mismatches: number;
  errors: number;
  skipped: number;
  timings?: {
    tsEvaluationDurationMsTotal: number;
    rustSummaryDurationMsTotal: number;
    tsEvaluationDurationMsAverage: number;
    rustSummaryDurationMsAverage: number;
    tapeRecordDurationMsTotal?: number;
    requestBuildDurationMsTotal?: number;
    rustIpcWriteDurationMsTotal?: number;
    rustResponseWaitDurationMsTotal?: number;
    rustResponseParseDurationMsTotal?: number;
    rustTotalDurationMsTotal?: number;
    compareDurationMsTotal?: number;
    candidateRequestBytesTotal?: number;
    candidateRequestDataBytesTotal?: number;
    candidateRequestAssumptionsBytesTotal?: number;
    candidateRequestTapeBytesTotal?: number;
    candidateRequestTapeBytesSavedTotal?: number;
    candidateRequestEnvelopeBytesTotal?: number;
    rustResponseBytesTotal?: number;
    tapeCacheHitsTotal?: number;
    tapeCacheMissesTotal?: number;
    compactTapeCacheHitsTotal?: number;
    compactTapeCacheMissesTotal?: number;
    tapeRecordDurationMsAverage?: number;
    requestBuildDurationMsAverage?: number;
    rustIpcWriteDurationMsAverage?: number;
    rustResponseWaitDurationMsAverage?: number;
    rustResponseParseDurationMsAverage?: number;
    rustTotalDurationMsAverage?: number;
    compareDurationMsAverage?: number;
    candidateRequestBytesAverage?: number;
    candidateRequestDataBytesAverage?: number;
    candidateRequestAssumptionsBytesAverage?: number;
    candidateRequestTapeBytesAverage?: number;
    candidateRequestTapeBytesSavedAverage?: number;
    candidateRequestEnvelopeBytesAverage?: number;
    rustResponseBytesAverage?: number;
    tapeCacheHitRate?: number;
    compactTapeCacheHitRate?: number;
  };
  firstMismatch: {
    policyId: string;
    field: string;
    expected: number;
    actual: number;
    delta: number;
    tolerance: number;
  } | null;
}

/**
 * Configuration for a miner session. Lets the UI/test rig override the
 * defaults without touching the enumerator code.
 */
export interface PolicyMiningSessionConfig {
  /** SeedData baseline to mine against. The engine clones this per policy. */
  baselineFingerprint: string;
  /** Engine version string for stamping records. */
  engineVersion: string;
  /** Axes to enumerate. */
  axes: PolicyAxes;
  /**
   * Feasibility threshold — policies with bequestAttainmentRate below this
   * are still stored (so we know they were evaluated) but flagged
   * non-feasible. Default 0.70.
   *
   * Lowered from 0.85 because at 0.85 the corpus surfaced very few
   * "feasible" candidates on realistic baselines — the household ends
   * up looking at empty Best-So-Far panels for hours. 0.70 still
   * means "≥70% of trials hit the legacy target" which is comfortably
   * above the median outcome but loose enough to actually find policies
   * worth comparing.
   */
  feasibilityThreshold: number;
  /** Hard cap on records to evaluate this session. Stops the miner after N. */
  maxPoliciesPerSession: number;
  /**
   * Phase 2.C — two-stage screening config (optional).
   *
   * When present, runMiningSession runs in TWO stages:
   *   1. Coarse pass: every policy evaluated at `coarseStage.trialCount`
   *      trials (much smaller than the full `assumptions.simulationRuns`).
   *      Standard error on success rate at e.g. N=200 is ≈ 1/√200 ≈ 7%
   *      — plenty to distinguish "obvious loser" from "contestant".
   *   2. Survivors (those whose coarse bequestAttainmentRate is ≥
   *      `feasibilityThreshold - coarseStage.feasibilityBuffer`) get
   *      re-evaluated at full `assumptions.simulationRuns`. Persisted
   *      records are ALWAYS the full-trial-count results — coarse
   *      evaluations are NOT saved to the corpus.
   *
   * Theoretical speedup at N=2000 fine, N=200 coarse, ~25% survival:
   *   baseline:   7,776 × 2,000 = 15.5M trial-evals
   *   two-stage:  7,776 × 200 + 1,944 × 2,000 = 1.55M + 3.89M = 5.4M
   *   speedup:    2.9× wall time, no correctness change for survivors.
   *
   * The risk is FALSE NEGATIVES — policies that look bad at low N but
   * would actually be feasible at full N. Set `feasibilityBuffer`
   * conservatively (>= 2× the coarse SE) to keep this <2% empirically.
   *
   * Omit (or set undefined) to disable — exact pre-Phase-2.C behavior.
   */
  coarseStage?: {
    /** Trial count for the coarse-pass evaluation. Typical: 100-200. */
    trialCount: number;
    /**
     * Buffer below feasibilityThreshold for survival cut. Policies with
     * coarse bequestAttainmentRate >= (feasibilityThreshold - buffer)
     * advance to the fine pass. Typical: 0.10 (10 percentage points,
     * ~1.4σ at N=200) — captures ~92% of true positives.
     */
    feasibilityBuffer: number;
  };
}
