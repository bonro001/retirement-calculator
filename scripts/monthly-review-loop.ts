import { mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import WebSocket from 'ws';
import { initialSeedData } from '../src/data';
import { defaultAssumptions } from '../src/default-assumptions';
import { buildEvaluationFingerprint } from '../src/evaluation-fingerprint';
import {
  buildMonthlyReviewMiningFingerprint,
  runMonthlyReview,
  type MonthlyReviewAiApproval,
  type MonthlyReviewRun,
  type MonthlyReviewStrategyDefinition,
  type MonthlyReviewStrategyId,
  type MonthlyReviewValidationPacket,
} from '../src/monthly-review';
import {
  makeMonthlyReviewMiningSeed,
} from '../src/monthly-review-cluster-miner';
import { buildDefaultPolicyAxes } from '../src/policy-axis-enumerator';
import { POLICY_MINING_TRIAL_COUNT } from '../src/policy-mining-config';
import {
  loadClusterEvaluations,
  loadClusterSessions,
  type ClusterSessionListing,
} from '../src/policy-mining-cluster';
import { runPolicyCertification } from '../src/policy-certification';
import {
  buildPolicyMinerRunEngineVersion,
  POLICY_MINER_ENGINE_VERSION,
  type PolicyMiningSessionConfig,
} from '../src/policy-miner-types';
import { LEGACY_ATTAINMENT_FLOOR } from '../src/policy-ranker';
import {
  HEARTBEAT_INTERVAL_MS,
  MINING_PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  type ClusterMessage,
  type HeartbeatMessage,
  type StartSessionMessage,
} from '../src/mining-protocol';
import {
  runMonthlyReviewAiApproval,
  sanitizeMonthlyReviewAiApproval,
} from '../cluster/monthly-review-ai-review';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env', override: false });

type AiMode = 'mock' | 'real' | 'off';
type MineMode = 'missing' | 'always' | 'never';

interface CliOptions {
  iterations: number;
  apiCalls: number;
  aiMode: AiMode;
  mineMode: MineMode;
  strategyIds: MonthlyReviewStrategyId[] | undefined;
  dispatcherUrl: string;
  outDir: string;
  mineTimeoutMs: number;
  maxCertCandidates: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    iterations: 5,
    apiCalls: 1,
    aiMode: process.env.OPENAI_API_KEY ? 'real' : 'mock',
    mineMode: 'missing',
    strategyIds: ['current_faithful'],
    dispatcherUrl: process.env.DISPATCHER_URL ?? 'ws://localhost:8765',
    outDir: 'artifacts/monthly-review-loop',
    mineTimeoutMs: 12 * 60 * 60 * 1_000,
    maxCertCandidates: 8,
  };

  for (const arg of argv) {
    const [rawKey, rawValue] = arg.replace(/^--/, '').split('=');
    const value = rawValue ?? '';
    switch (rawKey) {
      case 'iterations':
        opts.iterations = Math.max(1, Math.floor(Number(value)));
        break;
      case 'api-calls':
        opts.apiCalls = Math.max(0, Math.floor(Number(value)));
        break;
      case 'ai':
        if (value === 'mock' || value === 'real' || value === 'off') {
          opts.aiMode = value;
        } else {
          throw new Error(`Unsupported --ai=${value}; use mock, real, or off.`);
        }
        break;
      case 'mine':
        if (value === 'missing' || value === 'always' || value === 'never') {
          opts.mineMode = value;
        } else {
          throw new Error(`Unsupported --mine=${value}; use missing, always, or never.`);
        }
        break;
      case 'mine-timeout-minutes':
        opts.mineTimeoutMs = Math.max(1, Math.floor(Number(value))) * 60_000;
        break;
      case 'max-cert-candidates':
        opts.maxCertCandidates = Math.max(0, Math.floor(Number(value)));
        break;
      case 'strategy':
        if (value === 'all') {
          opts.strategyIds = undefined;
        } else if (value === 'current_faithful') {
          opts.strategyIds = [value];
        } else {
          throw new Error(
            `Unsupported --strategy=${value}; use current_faithful or all.`,
          );
        }
        break;
      case 'dispatcher':
        opts.dispatcherUrl = value;
        break;
      case 'out':
        opts.outDir = value;
        break;
      case 'help':
        printHelp();
        process.exit(0);
      default:
        if (rawKey) throw new Error(`Unknown option --${rawKey}`);
    }
  }

  if (opts.aiMode === 'real' && !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for --ai=real.');
  }
  return opts;
}

function printHelp(): void {
  console.log(`Monthly review CLI loop

Usage:
  npm run monthly-review:loop -- --iterations=5 --api-calls=1 --ai=real

Options:
  --strategy=current_faithful | all
  --ai=mock | real | off        mock is deterministic; real calls OpenAI
  --mine=missing | always | never
  --max-cert-candidates=N     exploratory cap; 0 means unlimited
  --api-calls=N                hard cap for real OpenAI calls
  --dispatcher=ws://host:8765  dispatcher HTTP/WS root
  --out=DIR                    artifact root
`);
}

function cloneSeed<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replaceAll(':', '').replaceAll('.', '-');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBaselineFingerprint(): string {
  return buildEvaluationFingerprint({
    data: initialSeedData,
    assumptions: defaultAssumptions,
    selectedStressors: [],
    selectedResponses: [],
  });
}

function buildMonthlyReviewRunEngineVersion(strategyFingerprint: string): string {
  const explorationSeed = makeMonthlyReviewMiningSeed(strategyFingerprint);
  return buildPolicyMinerRunEngineVersion(
    POLICY_MINER_ENGINE_VERSION,
    explorationSeed,
    POLICY_MINING_TRIAL_COUNT,
  );
}

function sessionCompleted(session: ClusterSessionListing): boolean {
  return session.summary?.state === 'completed' && session.evaluationCount > 0;
}

function findLatestSessionForFingerprint(
  sessions: ClusterSessionListing[],
  fingerprint: string,
  engineVersion: string,
): ClusterSessionListing | null {
  return (
    sessions.find(
      (session) =>
        sessionCompleted(session) &&
        session.manifest.config.baselineFingerprint === fingerprint &&
        session.manifest.config.engineVersion === engineVersion,
    ) ?? null
  );
}

async function startClusterMine(input: {
  dispatcherUrl: string;
  strategy: MonthlyReviewStrategyDefinition;
  strategyFingerprint: string;
  legacyTargetTodayDollars: number;
  timeoutMs: number;
}): Promise<string> {
  const axes = buildDefaultPolicyAxes(initialSeedData);
  const explorationSeed = makeMonthlyReviewMiningSeed(input.strategyFingerprint);
  const engineVersion = buildMonthlyReviewRunEngineVersion(input.strategyFingerprint);
  const assumptions = {
    ...defaultAssumptions,
    simulationRuns: POLICY_MINING_TRIAL_COUNT,
    simulationSeed: explorationSeed,
    assumptionsVersion: defaultAssumptions.assumptionsVersion
      ? `${defaultAssumptions.assumptionsVersion}-monthly-review-cli-seed-${explorationSeed}`
      : `monthly-review-cli-seed-${explorationSeed}`,
  };
  const config: PolicyMiningSessionConfig = {
    baselineFingerprint: input.strategyFingerprint,
    engineVersion,
    axes,
    feasibilityThreshold: LEGACY_ATTAINMENT_FLOOR,
    maxPoliciesPerSession: Number.MAX_SAFE_INTEGER,
    spendingScheduleBasis: input.strategy.spendingScheduleBasis ?? undefined,
  };

  console.log(
    `${input.strategy.label}: starting cluster mine (${POLICY_MINING_TRIAL_COUNT.toLocaleString()} trials, seed ${explorationSeed})`,
  );

  return await new Promise<string>((resolveSession, rejectSession) => {
    const ws = new WebSocket(input.dispatcherUrl);
    let peerId: string | null = null;
    let submitted = false;
    let seenSessionId: string | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let lastProgressAt = Date.now();
    const startedAt = Date.now();

    const closeHeartbeat = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };
    const finish = (error: Error | null, sessionId?: string) => {
      closeHeartbeat();
      try {
        ws.close();
      } catch {
        // Ignore close races; this promise is already settling.
      }
      if (error) rejectSession(error);
      else resolveSession(sessionId ?? seenSessionId ?? '');
    };
    const timeout = setInterval(() => {
      if (Date.now() - startedAt > input.timeoutMs) {
        clearInterval(timeout);
        finish(new Error(`${input.strategy.label}: cluster mine timed out.`));
      }
    }, 5_000);

    ws.on('open', () => {
      ws.send(
        encodeMessage({
          kind: 'register',
          protocolVersion: MINING_PROTOCOL_VERSION,
          roles: ['controller'],
          displayName: `monthly-review-loop-${hostname()}`,
        }),
      );
    });

    ws.on('message', (raw: Buffer) => {
      let message: ClusterMessage;
      try {
        message = decodeMessage(raw.toString('utf-8'));
      } catch {
        return;
      }

      if (message.kind === 'register_rejected') {
        clearInterval(timeout);
        finish(
          new Error(`Dispatcher rejected controller: ${message.reason} ${message.detail}`),
        );
        return;
      }

      if (message.kind === 'welcome') {
        peerId = message.peerId;
        heartbeatTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN || !peerId) return;
          const heartbeat: HeartbeatMessage = {
            kind: 'heartbeat',
            from: peerId,
            inFlightBatchIds: [],
            freeWorkerSlots: 0,
          };
          ws.send(encodeMessage(heartbeat));
        }, HEARTBEAT_INTERVAL_MS);
        if (message.clusterSnapshot.session) {
          clearInterval(timeout);
          finish(
            new Error(
              `Dispatcher already has active session ${message.clusterSnapshot.session.sessionId}. Let it finish or rerun with --mine=never.`,
            ),
          );
          return;
        }
        const start: StartSessionMessage = {
          kind: 'start_session',
          config,
          seedDataPayload: initialSeedData,
          marketAssumptionsPayload: assumptions,
          trialCount: POLICY_MINING_TRIAL_COUNT,
          legacyTargetTodayDollars: input.legacyTargetTodayDollars,
          from: peerId,
        };
        ws.send(encodeMessage(start));
        submitted = true;
        return;
      }

      if (message.kind === 'cluster_state' && submitted) {
        const session = message.snapshot.session;
        if (session) {
          seenSessionId = session.sessionId;
          const stats = session.stats;
          if (Date.now() - lastProgressAt > 10_000) {
            lastProgressAt = Date.now();
            console.log(
              `${input.strategy.label}: ${stats.policiesEvaluated.toLocaleString()} / ${stats.totalPolicies.toLocaleString()} policies`,
            );
          }
          return;
        }
        if (seenSessionId) {
          clearInterval(timeout);
          finish(null, seenSessionId);
        }
      }
    });

    ws.on('error', (error) => {
      clearInterval(timeout);
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function ensureClusterSession(input: {
  dispatcherUrl: string;
  sessions: ClusterSessionListing[];
  strategy: MonthlyReviewStrategyDefinition;
  strategyFingerprint: string;
  engineVersion: string;
  mineMode: MineMode;
  legacyTargetTodayDollars: number;
  timeoutMs: number;
}): Promise<{
  session: ClusterSessionListing | null;
  sessions: ClusterSessionListing[];
}> {
  if (input.mineMode !== 'always') {
    const existing = findLatestSessionForFingerprint(
      input.sessions,
      input.strategyFingerprint,
      input.engineVersion,
    );
    if (existing) return { session: existing, sessions: input.sessions };
  }
  if (input.mineMode === 'never') {
    return { session: null, sessions: input.sessions };
  }

  const sessionId = await startClusterMine({
    dispatcherUrl: input.dispatcherUrl,
    strategy: input.strategy,
    strategyFingerprint: input.strategyFingerprint,
    legacyTargetTodayDollars: input.legacyTargetTodayDollars,
    timeoutMs: input.timeoutMs,
  });
  await sleep(1_000);
  const sessions = await loadClusterSessions(input.dispatcherUrl);
  const session =
    sessions.find((candidate) => candidate.sessionId === sessionId) ??
    findLatestSessionForFingerprint(
      sessions,
      input.strategyFingerprint,
      input.engineVersion,
    );
  return { session: session ?? null, sessions };
}

function mockAiApproval(
  packet: MonthlyReviewValidationPacket,
  generatedAtIso: string,
): MonthlyReviewAiApproval {
  const hasSelectedPolicy = !!packet.rawExportEvidence.selectedPolicy;
  return sanitizeMonthlyReviewAiApproval(
    {
      verdict: hasSelectedPolicy ? 'aligned' : 'insufficient_data',
      confidence: 'high',
      summary: hasSelectedPolicy
        ? 'Deterministic mock co-review completed from the structured packet.'
        : 'Deterministic mock co-review could not find a selected policy.',
      findings: [],
      actionItems: [],
    },
    {
      model: 'mock-monthly-review-cli',
      generatedAtIso,
      packet,
    },
  );
}

function offAiApproval(
  packet: MonthlyReviewValidationPacket,
  generatedAtIso: string,
): MonthlyReviewAiApproval {
  return sanitizeMonthlyReviewAiApproval(
    {
      verdict: 'insufficient_data',
      confidence: 'low',
      summary: 'AI co-review is disabled for this CLI loop iteration.',
      findings: [
        {
          id: 'ai_disabled',
          status: 'fail',
          title: 'AI co-review disabled',
          detail:
            'This run can exercise mining and deterministic certification, but it cannot approve the monthly review.',
          evidence: ['--ai=off'],
          recommendation: 'Rerun with --ai=mock for deterministic rehearsal or --ai=real for final co-review.',
        },
      ],
      actionItems: ['Rerun with AI co-review enabled before adoption.'],
    },
    {
      model: 'ai-disabled',
      generatedAtIso,
      packet,
    },
  );
}

function summarizeRun(run: MonthlyReviewRun, packet: MonthlyReviewValidationPacket | null): string {
  const selected = packet?.rawExportEvidence.selectedPolicy;
  const blockers = run.modelTasks.filter(
    (task) => task.blocksApproval && task.status === 'open',
  );
  const lines = [
    `# Monthly Review CLI Iteration`,
    '',
    `- Status: ${run.recommendation.status}`,
    `- Strategy: ${run.recommendation.strategyId ?? 'none'}`,
    `- Spend: ${
      run.recommendation.annualSpendTodayDollars == null
        ? 'none'
        : `$${Math.round(run.recommendation.annualSpendTodayDollars).toLocaleString()}/yr`
    }`,
    `- Policy: ${run.recommendation.policyId ?? 'none'}`,
    `- Certification: ${run.recommendation.certificationVerdict ?? 'none'}`,
    `- AI verdict: ${run.aiApproval?.verdict ?? 'none'}`,
    `- API calls: ${run.apiCallCount}`,
    '',
    `## Selected Candidate`,
    '',
    selected
      ? `- Solvency: ${(selected.outcome.solventSuccessRate * 100).toFixed(1)}%`
      : '- none',
    selected
      ? `- Legacy attainment: ${(selected.outcome.bequestAttainmentRate * 100).toFixed(1)}%`
      : '',
    selected
      ? `- P10/P50/P90 ending wealth: $${Math.round(
          selected.outcome.p10EndingWealthTodayDollars,
        ).toLocaleString()} / $${Math.round(
          selected.outcome.p50EndingWealthTodayDollars,
        ).toLocaleString()} / $${Math.round(
          selected.outcome.p90EndingWealthTodayDollars,
        ).toLocaleString()}`
      : '',
    selected
      ? `- Lifetime federal tax estimate: $${Math.round(
          selected.outcome.medianLifetimeFederalTaxTodayDollars,
        ).toLocaleString()}`
      : '',
    selected?.spendingPath
      ? `- Spend path: ${selected.spendingPath.scalarMeaning}; first retirement $${Math.round(
          selected.spendingPath.firstRetirementYearAnnualSpendTodayDollars ?? 0,
        ).toLocaleString()}/yr; peak go-go $${Math.round(
          selected.spendingPath.peakGoGoAnnualSpendTodayDollars ?? 0,
        ).toLocaleString()}/yr; age 80 $${Math.round(
          selected.spendingPath.age80AnnualSpendTodayDollars ?? 0,
        ).toLocaleString()}/yr`
      : '',
    '',
    `## Blockers`,
    '',
    blockers.length === 0
      ? '- none'
      : blockers.map((task) => `- ${task.id}: ${task.title}`).join('\n'),
    '',
    `## AI Findings`,
    '',
    run.aiApproval?.findings.length
      ? run.aiApproval.findings
          .map(
            (finding) =>
              `- ${finding.status.toUpperCase()} ${finding.id}: ${finding.title}`,
          )
          .join('\n')
      : '- none',
    '',
  ];
  return `${lines.filter((line) => line !== '').join('\n')}\n`;
}

async function writeIterationArtifacts(input: {
  dir: string;
  run: MonthlyReviewRun;
  packet: MonthlyReviewValidationPacket | null;
  aiApproval: MonthlyReviewAiApproval | null;
  sessionMap: Record<string, string>;
  certificationAttempts: unknown[];
}): Promise<void> {
  await mkdir(input.dir, { recursive: true });
  await writeJson(resolve(input.dir, 'run.json'), input.run);
  await writeJson(resolve(input.dir, 'packet.json'), input.packet);
  await writeJson(resolve(input.dir, 'ai-response.json'), input.aiApproval);
  await writeJson(resolve(input.dir, 'sessions.json'), input.sessionMap);
  await writeJson(
    resolve(input.dir, 'certification-attempts.json'),
    input.certificationAttempts,
  );
  await writeFile(
    resolve(input.dir, 'summary.md'),
    summarizeRun(input.run, input.packet),
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const runRoot = resolve(opts.outDir, timestampForPath());
  await mkdir(runRoot, { recursive: true });

  const baselineFingerprint = buildBaselineFingerprint();
  let sessions = await loadClusterSessions(opts.dispatcherUrl);
  let realApiCalls = 0;

  console.log('\n=== monthly-review-loop ===');
  console.log(`Artifacts: ${runRoot}`);
  console.log(`Strategy: ${opts.strategyIds?.join(', ') ?? 'all'}`);
  console.log(`AI: ${opts.aiMode} (cap ${opts.apiCalls})`);
  console.log(`Mine: ${opts.mineMode}`);
  console.log(`Dispatcher: ${opts.dispatcherUrl}`);
  console.log(`Baseline: ${baselineFingerprint}`);

  for (let iteration = 1; iteration <= opts.iterations; iteration += 1) {
    console.log(`\n--- iteration ${iteration}/${opts.iterations} ---`);
    const generatedAtIso = new Date().toISOString();
    const iterationDir = resolve(
      runRoot,
      `iteration-${String(iteration).padStart(2, '0')}`,
    );
    await mkdir(iterationDir, { recursive: true });
    const sessionMap: Record<string, string> = {};
    const certificationAttempts: Array<{
      strategyId: MonthlyReviewStrategyId;
      policyId: string;
      annualSpendTodayDollars: number;
      verdict: string;
      reasons: string[];
      rows: unknown[];
      seedAudits: unknown[];
      attemptedAtIso: string;
    }> = [];
    const certAttemptCountByStrategy: Partial<Record<MonthlyReviewStrategyId, number>> = {};
    let lastPacket: MonthlyReviewValidationPacket | null = null;
    let lastAiApproval: MonthlyReviewAiApproval | null = null;

    const run = await runMonthlyReview({
      id: `cli-monthly-review-${iteration}`,
      baselineFingerprint,
      engineVersion: POLICY_MINER_ENGINE_VERSION,
      legacyTargetTodayDollars:
        initialSeedData.goals?.legacyTargetTodayDollars ?? 1_000_000,
      data: initialSeedData,
      assumptions: defaultAssumptions,
      generatedAtIso,
      strategyIds: opts.strategyIds,
      ports: {
        mineStrategy: async (strategy: MonthlyReviewStrategyDefinition) => {
          const strategyFingerprint = buildMonthlyReviewMiningFingerprint({
            baselineFingerprint,
            trialCount: POLICY_MINING_TRIAL_COUNT,
            strategy,
          });
          const ensured = await ensureClusterSession({
            dispatcherUrl: opts.dispatcherUrl,
            sessions,
            strategy,
            strategyFingerprint,
            engineVersion: buildMonthlyReviewRunEngineVersion(strategyFingerprint),
            mineMode: opts.mineMode,
            legacyTargetTodayDollars:
              initialSeedData.goals?.legacyTargetTodayDollars ?? 1_000_000,
            timeoutMs: opts.mineTimeoutMs,
          });
          sessions = ensured.sessions;
          const session = ensured.session;
          if (!session) {
            throw new Error(
              `No completed cluster session found for ${strategy.label} (${strategyFingerprint}). Rerun with --mine=missing or --mine=always.`,
            );
          }
          sessionMap[strategy.id] = session.sessionId;
          console.log(
            `${strategy.label}: using ${session.sessionId} (${session.evaluationCount.toLocaleString()} evals)`,
          );
          const payload = await loadClusterEvaluations(
            opts.dispatcherUrl,
            session.sessionId,
          );
          return { evaluations: payload.evaluations };
        },
        certifyCandidate: async (strategy, evaluation) => {
          const previousCount = certAttemptCountByStrategy[strategy.id] ?? 0;
          if (
            opts.maxCertCandidates > 0 &&
            previousCount >= opts.maxCertCandidates
          ) {
            throw new Error(
              `${strategy.label}: stopped after ${opts.maxCertCandidates} certification candidates without green. See certification-attempts.json.`,
            );
          }
          certAttemptCountByStrategy[strategy.id] = previousCount + 1;
          console.log(
            `${strategy.label}: certifying ${evaluation.id} at $${evaluation.policy.annualSpendTodayDollars.toLocaleString()}/yr (${certAttemptCountByStrategy[strategy.id]}${opts.maxCertCandidates > 0 ? `/${opts.maxCertCandidates}` : ''})`,
          );
          const pack = await runPolicyCertification({
            policy: evaluation.policy,
            baseline: initialSeedData,
            assumptions: defaultAssumptions,
            baselineFingerprint: evaluation.baselineFingerprint,
            engineVersion: evaluation.engineVersion,
            legacyTargetTodayDollars:
              initialSeedData.goals?.legacyTargetTodayDollars ?? 1_000_000,
            cloner: cloneSeed,
            spendingScheduleBasis: strategy.spendingScheduleBasis,
            generatedAtIso,
          });
          certificationAttempts.push({
            strategyId: strategy.id,
            policyId: evaluation.id,
            annualSpendTodayDollars: evaluation.policy.annualSpendTodayDollars,
            verdict: pack.verdict,
            reasons: pack.reasons.map((reason) => `${reason.code}: ${reason.message}`),
            rows: pack.rows,
            seedAudits: pack.seedAudits,
            attemptedAtIso: new Date().toISOString(),
          });
          await writeJson(
            resolve(iterationDir, 'certification-attempts.json'),
            certificationAttempts,
          );
          console.log(
            `${strategy.label}: ${evaluation.id} certification ${pack.verdict}`,
          );
          return {
            strategyId: strategy.id,
            evaluation,
            pack,
            verdict: pack.verdict,
            certifiedAtIso: new Date().toISOString(),
          };
        },
        aiReview: async (packet) => {
          lastPacket = packet;
          if (opts.aiMode === 'off') {
            lastAiApproval = offAiApproval(packet, new Date().toISOString());
            return lastAiApproval;
          }
          if (opts.aiMode === 'mock') {
            lastAiApproval = mockAiApproval(packet, new Date().toISOString());
            return lastAiApproval;
          }
          if (realApiCalls >= opts.apiCalls) {
            throw new Error(
              `OpenAI API call cap reached (${realApiCalls}/${opts.apiCalls}).`,
            );
          }
          realApiCalls += 1;
          lastAiApproval = await runMonthlyReviewAiApproval({ packet });
          return lastAiApproval;
        },
      },
    });

    await writeIterationArtifacts({
      dir: iterationDir,
      run,
      packet: lastPacket,
      aiApproval: lastAiApproval,
      sessionMap,
      certificationAttempts,
    });

    console.log(
      `result: ${run.recommendation.status} · spend=${
        run.recommendation.annualSpendTodayDollars == null
          ? 'none'
          : `$${run.recommendation.annualSpendTodayDollars.toLocaleString()}/yr`
      } · ai=${run.aiApproval?.verdict ?? 'none'} · artifacts=${iterationDir}`,
    );

    if (run.recommendation.status === 'green') {
      console.log('\nGreen monthly review reached.');
      break;
    }
  }

  await writeJson(resolve(runRoot, 'manifest.json'), {
    generatedAtIso: new Date().toISOString(),
    baselineFingerprint,
    options: opts,
    realApiCalls,
  });
  console.log(`\nDone. Artifacts written to ${runRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
