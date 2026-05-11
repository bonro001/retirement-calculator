/**
 * Cluster mining CLI with in-memory seed overrides.
 *
 * Applies parameter overrides to initialSeedData entirely in memory —
 * seed-data.json and all site files are never touched — then submits a
 * full mining session to the running dispatcher so all connected hosts
 * (every machine on the cluster) evaluate the policy corpus.
 *
 * Prerequisite: dispatcher must be running (npm run cluster:dispatcher)
 * and at least one host must be connected (npm run cluster:host on each machine).
 *
 * Usage:
 *   node --import tsx scripts/mine-query.ts [options]
 *
 * Options:
 *   --retirement-date YYYY-MM-DD   patch income.salaryEndDate
 *   --essential-monthly N          patch spending.essentialMonthly
 *   --optional-monthly N           patch spending.optionalMonthly
 *   --trials N                     trials per policy (default 2000)
 *   --dispatcher URL               WebSocket URL (default ws://localhost:8765)
 *
 * Example:
 *   node --import tsx scripts/mine-query.ts --retirement-date 2028-04-28
 *   node --import tsx scripts/mine-query.ts --essential-monthly 5500 --optional-monthly 5500
 */

import { createHash, randomInt } from 'node:crypto';
import { hostname } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { initialSeedData } from '../src/data';
import { defaultAssumptions } from '../src/default-assumptions';
import { buildDefaultPolicyAxes, countPolicyCandidates } from '../src/policy-axis-enumerator';
import { readEvaluations } from '../cluster/corpus-reader';
import { DEFAULT_DATA_DIR, type SessionSummary } from '../cluster/corpus-writer';
import type { PolicyEvaluation } from '../src/policy-miner-types';
import {
  buildPolicyMinerRunEngineVersion,
  POLICY_MINER_ENGINE_VERSION,
  type PolicyMiningSessionConfig,
} from '../src/policy-miner-types';
import {
  DEFAULT_DISPATCHER_PORT,
  HEARTBEAT_INTERVAL_MS,
  MINING_PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  type ClusterMessage,
  type ClusterSnapshot,
  type HeartbeatMessage,
  type StartSessionMessage,
} from '../src/mining-protocol';
import type { SeedData } from '../src/types';

// --- arg parsing ---

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      result[argv[i].slice(2)] = argv[i + 1] ?? 'true';
      i++;
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

// --- in-memory seed override (never writes any file) ---

function applyOverrides(base: SeedData, overrides: Record<string, string>): SeedData {
  let data = base;

  if (overrides['retirement-date']) {
    data = { ...data, income: { ...data.income, salaryEndDate: overrides['retirement-date'] } };
  }

  if (overrides['essential-monthly'] !== undefined) {
    data = {
      ...data,
      spending: { ...data.spending, essentialMonthly: Number(overrides['essential-monthly']) },
    };
  }

  if (overrides['optional-monthly'] !== undefined) {
    data = {
      ...data,
      spending: { ...data.spending, optionalMonthly: Number(overrides['optional-monthly']) },
    };
  }

  if (overrides['cash'] !== undefined) {
    data = {
      ...data,
      accounts: {
        ...data.accounts,
        cash: { ...data.accounts.cash, balance: Number(overrides['cash']) },
      },
    };
  }

  return data;
}

const overrideKeys = Object.keys(args).filter((k) => k !== 'trials' && k !== 'dispatcher');
const seed = applyOverrides(initialSeedData, args);
const trialCount = Number(args['trials'] ?? 2000);
const legacyTargetTodayDollars = Number(args['legacy-target'] ?? 1_000_000);
const dispatcherUrl = args['dispatcher'] ?? `ws://localhost:${DEFAULT_DISPATCHER_PORT}`;
const explorationSeed = randomInt(1, 2_147_483_647);

const assumptions = {
  ...defaultAssumptions,
  simulationRuns: trialCount,
  simulationSeed: explorationSeed,
  assumptionsVersion: `mine-query-seed-${explorationSeed}`,
};

function computeBaselineFingerprint(s: SeedData): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(s, Object.keys(s).sort()))
    .digest('hex');
  return `cli-${hash.slice(0, 16)}`;
}

// --- progress rendering ---

let lastEvaluated = 0;
let lastTickMs = Date.now();
let sessionStartMs = 0;

function renderProgress(snap: ClusterSnapshot): void {
  if (!snap.session) return;
  const stats = snap.session.stats;
  const metrics = snap.session.metrics;
  const now = Date.now();

  const newSince = stats.policiesEvaluated - lastEvaluated;
  const elapsedSec = (now - lastTickMs) / 1000;
  const polPerSec = elapsedSec > 0 && newSince > 0 ? (newSince / elapsedSec).toFixed(1) : '—';
  lastEvaluated = stats.policiesEvaluated;
  lastTickMs = now;

  const pct =
    stats.totalPolicies > 0
      ? ((stats.policiesEvaluated / stats.totalPolicies) * 100).toFixed(1)
      : '0.0';
  const eta =
    stats.estimatedRemainingMs > 0
      ? (stats.estimatedRemainingMs / 60_000).toFixed(1) + ' min'
      : '?';

  const activeHosts = metrics?.activeHostCount ?? snap.peers.filter((p) => p.roles.includes('host')).length;
  const totalHosts = snap.peers.filter((p) => p.roles.includes('host')).length;
  const utilization = metrics?.hostUtilizationRate != null
    ? `${Math.round(metrics.hostUtilizationRate * 100)}%`
    : '—';

  const phase = stats.totalPolicies > 0 ? 'fine' : 'coarse';

  process.stdout.write(
    `\r  [${phase}] ${pct.padStart(5)}%` +
    `  ${stats.policiesEvaluated}/${stats.totalPolicies || '?'} policies` +
    `  ${polPerSec} pol/s` +
    `  hosts=${activeHosts}/${totalHosts}` +
    `  util=${utilization}` +
    `  eta=${eta}     `,
  );
}

function renderSummary(snap: ClusterSnapshot, wallMs: number): void {
  const stats = snap.session?.stats;
  const metrics = snap.session?.metrics;
  if (!stats) return;
  const wallSec = (wallMs / 1000).toFixed(1);
  const avgMs = stats.meanMsPerPolicy > 0 ? stats.meanMsPerPolicy.toFixed(0) : '—';
  console.log(`\n\n  Session complete in ${wallSec}s`);
  console.log(`  Policies evaluated:  ${stats.policiesEvaluated}`);
  console.log(`  Feasible policies:   ${stats.feasiblePolicies}`);
  console.log(`  Avg ms/policy:       ${avgMs}ms`);
  if (metrics?.hostUtilizationRate != null) {
    console.log(`  Avg host utilization: ${Math.round(metrics.hostUtilizationRate * 100)}%`);
  }
  if (metrics?.avgBatchSize != null) {
    console.log(`  Avg batch size:      ${metrics.avgBatchSize.toFixed(1)}`);
  }
}

function readSessionSummary(sessionId: string): SessionSummary | null {
  const summaryPath = join(DEFAULT_DATA_DIR, 'sessions', sessionId, 'summary.json');
  if (!existsSync(summaryPath)) return null;
  try {
    return JSON.parse(readFileSync(summaryPath, 'utf-8')) as SessionSummary;
  } catch {
    return null;
  }
}

function renderTopPolicies(sessionId: string): void {
  const summary = readSessionSummary(sessionId);
  const evaluations = readEvaluations(sessionId);
  if (evaluations.length === 0) {
    console.log('\n  (no evaluations on disk — session may still be flushing)');
    return;
  }

  // Rank by bequest attainment first, break ties by median lifetime spend.
  // Mirrors the policy-miner ranking concept: hit the legacy target,
  // then maximize what you actually got to spend along the way.
  const ranked = [...evaluations].sort((a, b) => {
    const bequestDelta = b.outcome.bequestAttainmentRate - a.outcome.bequestAttainmentRate;
    if (Math.abs(bequestDelta) > 0.001) return bequestDelta;
    return b.outcome.medianLifetimeSpendTodayDollars - a.outcome.medianLifetimeSpendTodayDollars;
  });

  const best = summary?.bestPolicyId
    ? evaluations.find((e) => e.id === summary.bestPolicyId) ?? ranked[0]
    : ranked[0];

  const usd = (n: number) => '$' + Math.round(n).toLocaleString();
  const pct = (n: number) => (n * 100).toFixed(1) + '%';

  console.log('\n  --- Winning policy ---');
  console.log(`  Annual spend:        ${usd(best.policy.annualSpendTodayDollars)}  (${usd(best.policy.annualSpendTodayDollars / 12)}/mo)`);
  console.log(`  Primary SS claim:    age ${best.policy.primarySocialSecurityClaimAge}`);
  console.log(`  Spouse SS claim:     ${best.policy.spouseSocialSecurityClaimAge != null ? `age ${best.policy.spouseSocialSecurityClaimAge}` : '—'}`);
  console.log(`  Roth conv. ceiling:  ${usd(best.policy.rothConversionAnnualCeiling)}/yr`);
  console.log(`  Withdrawal rule:     ${best.policy.withdrawalRule ?? 'tax_bracket_waterfall'}`);
  console.log(`  Solvent success:     ${pct(best.outcome.solventSuccessRate)}`);
  console.log(`  Bequest attainment:  ${pct(best.outcome.bequestAttainmentRate)}`);
  console.log(`  Median ending (p50): ${usd(best.outcome.p50EndingWealthTodayDollars)}`);
  console.log(`  P10 ending:          ${usd(best.outcome.p10EndingWealthTodayDollars)}`);
  console.log(`  Median lifetime spend: ${usd(best.outcome.medianLifetimeSpendTodayDollars)}`);
  console.log(`  IRMAA exposure:      ${pct(best.outcome.irmaaExposureRate)}`);

  console.log('\n  --- Top 5 by bequest attainment, then lifetime spend ---');
  console.log('  rank  annual spend     mo spend    SS(p/s)    Roth cap     attain   solvent   p10 ending');
  console.log('  ' + '-'.repeat(94));
  for (let i = 0; i < Math.min(5, ranked.length); i++) {
    const e = ranked[i];
    const ss = `${e.policy.primarySocialSecurityClaimAge}/${e.policy.spouseSocialSecurityClaimAge ?? '-'}`;
    console.log(
      `  ${(i + 1).toString().padStart(4)}  ${usd(e.policy.annualSpendTodayDollars).padStart(13)}  ${usd(e.policy.annualSpendTodayDollars / 12).padStart(9)}  ${ss.padStart(9)}  ${usd(e.policy.rothConversionAnnualCeiling).padStart(10)}  ${pct(e.outcome.bequestAttainmentRate).padStart(7)}  ${pct(e.outcome.solventSuccessRate).padStart(8)}  ${usd(e.outcome.p10EndingWealthTodayDollars).padStart(12)}`,
    );
  }
  console.log(`\n  Session data on disk: ${join(DEFAULT_DATA_DIR, 'sessions', sessionId)}`);
}

// --- main ---

async function main(): Promise<void> {
  console.log('\n=== mine-query ===');
  console.log('Seed files: READ-ONLY — seed-data.json and site files untouched.');
  console.log(`Trials per policy: ${trialCount}  Dispatcher: ${dispatcherUrl}\n`);

  if (overrideKeys.length > 0) {
    console.log('Overrides (applied in memory only):');
    for (const k of overrideKeys) {
      let from = '';
      if (k === 'retirement-date') from = `${initialSeedData.income.salaryEndDate} → `;
      if (k === 'essential-monthly') from = `${initialSeedData.spending.essentialMonthly} → `;
      if (k === 'optional-monthly') from = `${initialSeedData.spending.optionalMonthly} → `;
      if (k === 'cash') from = `${initialSeedData.accounts.cash.balance} → `;
      console.log(`  --${k}: ${from}${args[k]}`);
    }
    console.log('');
  } else {
    console.log('No overrides — mining baseline seed.\n');
  }

  const baselineFingerprint = computeBaselineFingerprint(seed);
  const axes = buildDefaultPolicyAxes(seed);
  const totalCandidates = countPolicyCandidates(axes);

  // Auto-enable two-stage screening for large grids (mirrors start-session.ts logic)
  const COARSE_AUTO_THRESHOLD = 5000;
  const coarseTrials = totalCandidates >= COARSE_AUTO_THRESHOLD ? 200 : 0;
  const coarseStage = coarseTrials > 0 ? { trialCount: coarseTrials, feasibilityBuffer: 0.10 } : undefined;

  console.log(`Policy corpus: ${totalCandidates} candidates${coarseStage ? ' (two-stage screening)' : ''}`);
  console.log(`Baseline fingerprint: ${baselineFingerprint}\n`);

  const ws = new WebSocket(dispatcherUrl);

  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((res) => { resolveDone = res; });

  let sessionId: string | null = null;
  let started = false;
  let finished = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let lastSnap: ClusterSnapshot | null = null;

  const stopHeartbeat = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  };

  const startHeartbeat = (peerId: string) => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const hb: HeartbeatMessage = { kind: 'heartbeat', from: peerId, inFlightBatchIds: [], freeWorkerSlots: 0 };
      ws.send(encodeMessage(hb));
    }, HEARTBEAT_INTERVAL_MS);
  };

  ws.on('open', () => {
    console.log('Connected to dispatcher — registering as controller...');
    ws.send(encodeMessage({
      kind: 'register',
      protocolVersion: MINING_PROTOCOL_VERSION,
      roles: ['controller'],
      displayName: `mine-query-${hostname()}`,
    }));
  });

  ws.on('message', (raw: Buffer) => {
    let message: ClusterMessage;
    try {
      message = decodeMessage(raw.toString('utf-8'));
    } catch {
      return;
    }

    switch (message.kind) {
      case 'welcome': {
        startHeartbeat(message.peerId);
        const engineVersion = buildPolicyMinerRunEngineVersion(
          POLICY_MINER_ENGINE_VERSION,
          explorationSeed,
          trialCount,
        );
        const config: PolicyMiningSessionConfig = {
          baselineFingerprint,
          engineVersion,
          axes,
          feasibilityThreshold: 0.70,
          maxPoliciesPerSession: totalCandidates,
          coarseStage,
        };
        const start: StartSessionMessage = {
          kind: 'start_session',
          config,
          seedDataPayload: seed,
          marketAssumptionsPayload: assumptions,
          trialCount,
          legacyTargetTodayDollars,
          from: message.peerId,
        };
        ws.send(encodeMessage(start));
        console.log('Session submitted — waiting for hosts...\n');
        return;
      }
      case 'register_rejected': {
        console.error(`Rejected by dispatcher: ${message.reason}`);
        ws.close();
        resolveDone(1);
        return;
      }
      case 'cluster_state': {
        if (message.snapshot.session) {
          if (!started) {
            sessionId = message.snapshot.session.sessionId;
            started = true;
            sessionStartMs = Date.now();
            lastTickMs = sessionStartMs;
            const hostCount = message.snapshot.peers.filter((p) => p.roles.includes('host')).length;
            console.log(`Session active: ${sessionId}  (${hostCount} host(s) connected)\n`);
          }
          lastSnap = message.snapshot;
          renderProgress(message.snapshot);
        } else if (started && !finished) {
          finished = true;
          renderSummary(lastSnap!, Date.now() - sessionStartMs);
          if (sessionId) {
            renderTopPolicies(sessionId);
          }
          ws.close();
          resolveDone(0);
        }
        return;
      }
      default:
        break;
    }
  });

  ws.on('close', (code) => {
    stopHeartbeat();
    resolveDone(started ? 0 : 2);
  });

  ws.on('error', (err) => {
    stopHeartbeat();
    console.error(`Socket error: ${err instanceof Error ? err.message : String(err)}`);
    resolveDone(1);
  });

  process.on('SIGINT', () => {
    stopHeartbeat();
    if (sessionId) {
      console.log(`\nCancelling session ${sessionId}...`);
      try {
        ws.send(encodeMessage({ kind: 'cancel_session', sessionId, reason: 'mine-query SIGINT' }));
      } catch { /* already closed */ }
    }
    setTimeout(() => process.exit(130), 500).unref();
  });

  process.exitCode = await done;
}

main().catch((err) => {
  console.error('mine-query FAILED:', err);
  process.exit(1);
});
