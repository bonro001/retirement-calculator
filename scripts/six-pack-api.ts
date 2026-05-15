import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initialSeedData } from '../src/data';
import { defaultAssumptions } from '../src/default-assumptions';
import {
  evaluatePlan,
  type Plan,
  type PlanEvaluation,
} from '../src/plan-evaluation';
import type { SpendingTransaction } from '../src/spending-ledger';
import { applySpendingCategoryInferences } from '../src/spending-classification';
import { dedupeOverlappingLiveFeedTransactions } from '../src/spending-live-feed-dedupe';
import {
  applySpendingMerchantCategoryRules,
  applySpendingTransactionOverrides,
  buildSpendingMerchantCategoryRule,
  buildSpendingTransactionOverride,
  parseSpendingOverridesFilePayload,
  type SpendingMerchantCategoryRuleMap,
  type SpendingOverridesFilePayload,
  type SpendingTransactionOverrideMap,
} from '../src/spending-overrides';
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
const HOST = process.env.SIX_PACK_API_HOST ?? '0.0.0.0';
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
const SPENDING_OVERRIDES_FILE = 'public/local/spending-overrides.json';

interface LocalLedgerPayload {
  transactions?: SpendingTransaction[];
}

interface RecentSpendingTransactionPayload {
  idNumber: number;
  id: string;
  postedDate: string;
  transactionDate?: string;
  merchant: string;
  displayTitle?: string;
  description?: string;
  amount: number;
  currency: 'USD';
  categoryId?: string;
  classificationMethod?: string;
  ignored?: boolean;
  source?: SpendingTransaction['source'];
}

interface SpendingOverrideRequestBody {
  categoryId?: string;
  title?: string;
  applyToMerchant?: boolean;
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
  return dedupeOverlappingLiveFeedTransactions(transactions);
}

function emptySpendingOverridesPayload(): SpendingOverridesFilePayload {
  return {
    schemaVersion: 'spending-overrides-v1',
    updatedAtIso: new Date().toISOString(),
    transactionOverrides: {},
    merchantCategoryRules: {},
  };
}

async function loadSpendingOverrides(): Promise<SpendingOverridesFilePayload> {
  const fullPath = path.resolve(SPENDING_OVERRIDES_FILE);
  if (!existsSync(fullPath)) return emptySpendingOverridesPayload();
  const parsed = parseSpendingOverridesFilePayload(
    JSON.parse(await readFile(fullPath, 'utf8')),
  );
  return parsed ?? emptySpendingOverridesPayload();
}

async function saveSpendingOverrides(input: {
  transactionOverrides: SpendingTransactionOverrideMap;
  merchantCategoryRules: SpendingMerchantCategoryRuleMap;
}): Promise<SpendingOverridesFilePayload> {
  const payload: SpendingOverridesFilePayload = {
    schemaVersion: 'spending-overrides-v1',
    updatedAtIso: new Date().toISOString(),
    transactionOverrides: input.transactionOverrides,
    merchantCategoryRules: input.merchantCategoryRules,
  };
  await writeFile(
    path.resolve(SPENDING_OVERRIDES_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
  return payload;
}

async function loadBudgetTransactions(): Promise<SpendingTransaction[]> {
  const transactions = applySpendingCategoryInferences(await loadTransactions());
  const overrides = await loadSpendingOverrides();
  return applySpendingTransactionOverrides(
    applySpendingMerchantCategoryRules(
      transactions,
      overrides.merchantCategoryRules,
    ),
    overrides.transactionOverrides,
  );
}

function recentIdNumber(transactionId: string): number {
  let hash = 2166136261;
  for (const char of transactionId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % 1_000_000_000;
}

function recentTransactionPayload(
  transaction: SpendingTransaction,
): RecentSpendingTransactionPayload {
  return {
    idNumber: recentIdNumber(transaction.id),
    id: transaction.id,
    postedDate: transaction.postedDate,
    ...(transaction.transactionDate ? { transactionDate: transaction.transactionDate } : {}),
    merchant: transaction.merchant,
    ...(transaction.displayTitle ? { displayTitle: transaction.displayTitle } : {}),
    ...(transaction.description ? { description: transaction.description } : {}),
    amount: transaction.amount,
    currency: transaction.currency,
    ...(transaction.categoryId ? { categoryId: transaction.categoryId } : {}),
    ...(transaction.classificationMethod
      ? { classificationMethod: transaction.classificationMethod }
      : {}),
    ...(transaction.ignored !== undefined ? { ignored: transaction.ignored } : {}),
    ...(transaction.source ? { source: transaction.source } : {}),
  };
}

async function loadRecentSpendingTransactions(
  limit: number,
): Promise<RecentSpendingTransactionPayload[]> {
  const transactions = await loadBudgetTransactions();
  return transactions
    .filter((transaction) => transaction.amount > 0)
    .sort((left, right) => {
      const dateCompare = right.postedDate.localeCompare(left.postedDate);
      if (dateCompare !== 0) return dateCompare;
      return right.amount - left.amount;
    })
    .slice(0, limit)
    .map(recentTransactionPayload);
}

async function transactionIdForRecentIdNumber(
  idNumber: number,
): Promise<string | null> {
  const transactions = await loadRecentSpendingTransactions(250);
  return (
    transactions.find((transaction) => transaction.idNumber === idNumber)?.id ?? null
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

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

async function saveTransactionOverride(input: {
  transactionId: string;
  categoryId: string;
  title?: string;
  applyToMerchant?: boolean;
}): Promise<SpendingOverridesFilePayload> {
  const overrides = await loadSpendingOverrides();
  const transactionOverrides = { ...overrides.transactionOverrides };
  const merchantCategoryRules = { ...overrides.merchantCategoryRules };
  transactionOverrides[input.transactionId] = buildSpendingTransactionOverride({
    transactionId: input.transactionId,
    categoryId: input.categoryId,
    title: input.title,
  });
  if (input.applyToMerchant) {
    const transaction = (await loadTransactions()).find(
      (candidate) => candidate.id === input.transactionId,
    );
    if (transaction) {
      const rule = buildSpendingMerchantCategoryRule({
        merchant: transaction.merchant,
        categoryId: input.categoryId,
      });
      merchantCategoryRules[rule.merchantKey] = rule;
    }
  }
  return saveSpendingOverrides({ transactionOverrides, merchantCategoryRules });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      response.end();
      return;
    }
    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' });
        return;
      }
      writeJson(response, 200, {
        state: 'ok',
        service: 'six-pack-api',
        as_of: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname === '/api/spending/overrides') {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' });
        return;
      }
      writeJson(response, 200, await loadSpendingOverrides());
      return;
    }

    if (url.pathname === '/api/spending/transactions/recent') {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' });
        return;
      }
      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get('limit') ?? 25) || 25),
      );
      const transactions = await loadRecentSpendingTransactions(limit);
      writeJson(response, 200, {
        count: transactions.length,
        idNumberScope: 'fnv1a_transaction_id_v1',
        transactions,
      });
      return;
    }

    const directOverrideMatch =
      /^\/api\/spending\/transactions\/([^/]+)\/override$/.exec(url.pathname);
    if (directOverrideMatch) {
      if (request.method !== 'POST' && request.method !== 'DELETE') {
        writeJson(response, 405, { error: 'method_not_allowed' });
        return;
      }
      const transactionId = decodeURIComponent(directOverrideMatch[1]);
      const overrides = await loadSpendingOverrides();
      if (request.method === 'DELETE') {
        const transactionOverrides = { ...overrides.transactionOverrides };
        delete transactionOverrides[transactionId];
        writeJson(
          response,
          200,
          await saveSpendingOverrides({
            transactionOverrides,
            merchantCategoryRules: overrides.merchantCategoryRules,
          }),
        );
        return;
      }
      const body = (await readJsonBody(request)) as SpendingOverrideRequestBody;
      if (typeof body.categoryId !== 'string' || !body.categoryId.trim()) {
        writeJson(response, 400, { error: 'category_id_required' });
        return;
      }
      writeJson(
        response,
        200,
        await saveTransactionOverride({
          transactionId,
          categoryId: body.categoryId,
          title: body.title,
          applyToMerchant: body.applyToMerchant,
        }),
      );
      return;
    }

    const recentOverrideMatch =
      /^\/api\/spending\/transactions\/recent\/(\d+)\/override$/.exec(
        url.pathname,
      );
    if (recentOverrideMatch) {
      if (request.method !== 'POST' && request.method !== 'DELETE') {
        writeJson(response, 405, { error: 'method_not_allowed' });
        return;
      }
      const transactionId = await transactionIdForRecentIdNumber(
        Number(recentOverrideMatch[1]),
      );
      if (!transactionId) {
        writeJson(response, 404, { error: 'recent_transaction_not_found' });
        return;
      }
      if (request.method === 'DELETE') {
        const overrides = await loadSpendingOverrides();
        const transactionOverrides = { ...overrides.transactionOverrides };
        delete transactionOverrides[transactionId];
        writeJson(
          response,
          200,
          await saveSpendingOverrides({
            transactionOverrides,
            merchantCategoryRules: overrides.merchantCategoryRules,
          }),
        );
        return;
      }
      const body = (await readJsonBody(request)) as SpendingOverrideRequestBody;
      if (typeof body.categoryId !== 'string' || !body.categoryId.trim()) {
        writeJson(response, 400, { error: 'category_id_required' });
        return;
      }
      writeJson(
        response,
        200,
        await saveTransactionOverride({
          transactionId,
          categoryId: body.categoryId,
          title: body.title,
          applyToMerchant: body.applyToMerchant,
        }),
      );
      return;
    }

    const recentIgnoreMatch =
      /^\/api\/spending\/transactions\/recent\/(\d+)\/ignore$/.exec(
        url.pathname,
      );
    if (recentIgnoreMatch) {
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method_not_allowed' });
        return;
      }
      const transactionId = await transactionIdForRecentIdNumber(
        Number(recentIgnoreMatch[1]),
      );
      if (!transactionId) {
        writeJson(response, 404, { error: 'recent_transaction_not_found' });
        return;
      }
      const body = (await readJsonBody(request)) as SpendingOverrideRequestBody;
      writeJson(
        response,
        200,
        await saveTransactionOverride({
          transactionId,
          categoryId: 'ignored',
          title: body.title,
        }),
      );
      return;
    }

    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'method_not_allowed' });
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
