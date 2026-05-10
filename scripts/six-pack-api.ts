import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { initialSeedData } from '../src/data';
import { defaultAssumptions } from '../src/default-assumptions';
import {
  evaluatePlan,
  type Plan,
  type PlanEvaluation,
} from '../src/plan-evaluation';
import type { SpendingTransaction } from '../src/spending-ledger';
import { applySpendingCategoryInferences, splitAmazonCreditCardTransactionsForBudget } from '../src/spending-classification';
import { dedupeOverlappingLiveFeedTransactions } from '../src/spending-live-feed-dedupe';
import { buildSixPackSpendingContext } from '../src/six-pack-spending';
import { buildSixPackSnapshot } from '../src/six-pack-rules';
import type { SixPackInstrumentId, SixPackSnapshot } from '../src/six-pack-types';
import {
  buildPortfolioWeatherSnapshot,
  type PortfolioQuoteSnapshot,
} from '../src/portfolio-weather';
import {
  buildHomeAssistantSixPackInstrumentPayload,
  buildHomeAssistantSixPackPanelPayload,
  buildHomeAssistantSixPackPayload,
} from '../src/home-assistant-six-pack-contract';
import { DEFAULT_LEGACY_TARGET_TODAY_DOLLARS } from '../src/legacy-target-cache';

const PORT = Number(process.env.SIX_PACK_API_PORT ?? 8787);
const HOST = process.env.SIX_PACK_API_HOST ?? '127.0.0.1';
const PLAN_EVALUATION_ENABLED = process.env.SIX_PACK_API_PLAN_EVAL !== 'off';
const PLAN_EVALUATION_CACHE_MS = Number(
  process.env.SIX_PACK_API_PLAN_EVAL_CACHE_MS ?? 15 * 60 * 1000,
);
const LOCAL_LEDGER_FILES = [
  'public/local/spending-ledger.chase4582.json',
  'public/local/spending-ledger.amex.json',
  'public/local/spending-ledger.sofi.json',
  'public/local/spending-ledger.gmail.json',
];
const PORTFOLIO_QUOTES_FILE = 'public/local/portfolio-quotes.json';

interface LocalLedgerPayload {
  transactions?: SpendingTransaction[];
}

interface CachedPlanEvaluation {
  evaluation: PlanEvaluation;
  capturedAtIso: string;
  expiresAtMs: number;
}

const validInstrumentIds: SixPackInstrumentId[] = [
  'lifestyle_pace',
  'cash_runway',
  'portfolio_weather',
  'plan_integrity',
  'tax_cliffs',
  'watch_items',
];

let cachedPlanEvaluation: CachedPlanEvaluation | null = null;
let planEvaluationInFlight: Promise<CachedPlanEvaluation | null> | null = null;

function buildSixPackEvaluationPlan(): Plan {
  return {
    data: initialSeedData,
    assumptions: {
      ...defaultAssumptions,
      simulationRuns: 180,
      assumptionsVersion: `${defaultAssumptions.assumptionsVersion ?? 'v1'}-six-pack-api`,
    },
    controls: {
      selectedStressorIds: [],
      selectedResponseIds: [],
      toggles: {
        preserveRoth: false,
        increaseCashBuffer: false,
        avoidRetirementDelayRecommendations: true,
        avoidHomeSaleRecommendations: true,
      },
    },
    preferences: {
      irmaaPosture: 'balanced',
      preserveLifestyleFloor: true,
      timePreference: {
        ages60to69: 'high',
        ages70to79: 'medium',
        ages80plus: 'low',
      },
      calibration: {
        targetLegacyTodayDollars: DEFAULT_LEGACY_TARGET_TODAY_DOLLARS,
        legacyPriority: 'important',
        successFloorMode: 'balanced',
        minSuccessRate: 0.92,
        optimizationObjective: 'maximize_time_weighted_spending',
      },
      responsePolicy: {
        posture: 'defensive',
        optionalSpendingCutsAllowed: true,
        optionalSpendingFlexPercent: 12,
        travelFlexPercent: 20,
        preserveRothPreference: false,
      },
      runtime: {
        timeoutMs: 60_000,
        finalEvaluationSimulationRuns: 180,
        solverSearchSimulationRuns: 90,
        solverFinalSimulationRuns: 180,
        solverMaxIterations: 14,
        solverDiagnosticsMode: 'core',
        solverEnableSuccessRelaxationProbe: false,
        decisionSimulationRuns: 72,
        decisionScenarioEvaluationLimit: 12,
        decisionEvaluateExcludedScenarios: false,
        stressTestComplexity: 'reduced',
      },
    },
  };
}

async function loadPlanEvaluation(): Promise<CachedPlanEvaluation | null> {
  if (!PLAN_EVALUATION_ENABLED) return null;
  const now = Date.now();
  if (cachedPlanEvaluation && cachedPlanEvaluation.expiresAtMs > now) {
    return cachedPlanEvaluation;
  }
  if (planEvaluationInFlight) return planEvaluationInFlight;
  planEvaluationInFlight = evaluatePlan(buildSixPackEvaluationPlan())
    .then((evaluation) => {
      const capturedAtIso = new Date().toISOString();
      const cached = {
        evaluation,
        capturedAtIso,
        expiresAtMs: Date.now() + PLAN_EVALUATION_CACHE_MS,
      };
      cachedPlanEvaluation = cached;
      return cached;
    })
    .catch((error) => {
      console.warn(
        `six-pack-api plan evaluation unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    })
    .finally(() => {
      planEvaluationInFlight = null;
    });
  return planEvaluationInFlight;
}

async function loadTransactions(): Promise<SpendingTransaction[]> {
  const payloads = await Promise.all(
    LOCAL_LEDGER_FILES.map(async (file) => {
      const fullPath = path.resolve(file);
      if (!existsSync(fullPath)) return null;
      const raw = await readFile(fullPath, 'utf8');
      return JSON.parse(raw) as LocalLedgerPayload;
    }),
  );
  const transactions = payloads.flatMap((payload) => payload?.transactions ?? []);
  return splitAmazonCreditCardTransactionsForBudget(
    applySpendingCategoryInferences(
      dedupeOverlappingLiveFeedTransactions(transactions),
    ),
  );
}

async function loadQuoteSnapshot(): Promise<PortfolioQuoteSnapshot | null> {
  const fullPath = path.resolve(PORTFOLIO_QUOTES_FILE);
  if (!existsSync(fullPath)) return null;
  return JSON.parse(await readFile(fullPath, 'utf8')) as PortfolioQuoteSnapshot;
}

async function buildSnapshot(): Promise<SixPackSnapshot> {
  const asOfIso = new Date().toISOString();
  const transactions = await loadTransactions();
  const quoteSnapshot = await loadQuoteSnapshot();
  const planEvaluation = await loadPlanEvaluation();
  const spending = transactions.length
    ? buildSixPackSpendingContext({
        data: initialSeedData,
        transactions,
        asOfIso,
        ledgerStatus: 'loaded',
      })
    : null;
  const portfolioWeather = buildPortfolioWeatherSnapshot({
    data: initialSeedData,
    quoteSnapshot,
    asOfIso,
  });
  return buildSixPackSnapshot({
    data: initialSeedData,
    spending,
    portfolioWeather,
    evaluation: planEvaluation?.evaluation ?? null,
    evaluationCapturedAtIso: planEvaluation?.capturedAtIso ?? null,
    asOfIso,
  });
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(payload, null, 2));
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      response.end();
      return;
    }
    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    if (url.pathname === '/api/health') {
      writeJson(response, 200, {
        state: 'ok',
        service: 'six-pack-api',
        as_of: new Date().toISOString(),
      });
      return;
    }

    const snapshot = await buildSnapshot();
    if (url.pathname === '/api/six-pack') {
      writeJson(response, 200, snapshot);
      return;
    }
    if (url.pathname === '/api/home-assistant/six-pack') {
      writeJson(response, 200, buildHomeAssistantSixPackPayload(snapshot));
      return;
    }
    if (url.pathname === '/api/home-assistant/six-pack/panel') {
      writeJson(response, 200, buildHomeAssistantSixPackPanelPayload(snapshot));
      return;
    }

    const match = /^\/api\/home-assistant\/six-pack\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const instrumentId = match[1] as SixPackInstrumentId;
      if (!validInstrumentIds.includes(instrumentId)) {
        writeJson(response, 404, { error: 'unknown_instrument' });
        return;
      }
      const instrument = snapshot.instruments.find((item) => item.id === instrumentId);
      if (!instrument) {
        writeJson(response, 404, { error: 'instrument_unavailable' });
        return;
      }
      writeJson(
        response,
        200,
        buildHomeAssistantSixPackInstrumentPayload(instrument, snapshot.asOfIso),
      );
      return;
    }

    writeJson(response, 404, { error: 'not_found' });
  } catch (error) {
    writeJson(response, 500, {
      error: 'six_pack_snapshot_failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`six-pack-api listening on http://${HOST}:${PORT}`);
  void loadPlanEvaluation();
});
