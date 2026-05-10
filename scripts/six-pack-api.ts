import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import {
  applySpendingMerchantCategoryRules,
  applySpendingTransactionOverrides,
  buildSpendingMerchantCategoryRule,
  buildSpendingTransactionOverride,
  type SpendingMerchantCategoryRuleMap,
  type SpendingTransactionOverrideMap,
} from '../src/spending-overrides';
import {
  normalizeSpendingOverrideStorePayload,
  type SpendingOverrideStorePayload,
} from '../src/spending-override-store';
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
const SPENDING_OVERRIDES_FILE = 'public/local/spending-overrides.json';
const VALID_SPENDING_CATEGORY_IDS = new Set([
  'essential',
  'optional',
  'amazon_uncategorized',
  'health',
  'travel',
  'taxes_insurance',
  'long_term_items',
  'generosity',
  'family_transfers',
  'ignored',
  'uncategorized',
]);

interface LocalLedgerPayload {
  transactions?: SpendingTransaction[];
}

interface SpendingOverrideRequestBody {
  categoryId?: unknown;
  title?: unknown;
  applyToMerchant?: unknown;
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

async function loadRawTransactions(): Promise<SpendingTransaction[]> {
  const payloads = await Promise.all(
    LOCAL_LEDGER_FILES.map(async (file) => {
      const fullPath = path.resolve(file);
      if (!existsSync(fullPath)) return null;
      const raw = await readFile(fullPath, 'utf8');
      return JSON.parse(raw) as LocalLedgerPayload;
    }),
  );
  const transactions = payloads.flatMap((payload) => payload?.transactions ?? []);
  return applySpendingCategoryInferences(
    dedupeOverlappingLiveFeedTransactions(transactions),
  );
}

async function loadOverrideStore(): Promise<SpendingOverrideStorePayload> {
  const fullPath = path.resolve(SPENDING_OVERRIDES_FILE);
  if (!existsSync(fullPath)) {
    return {
      schemaVersion: 'spending-overrides-v1',
      updatedAtIso: null,
      transactionOverrides: {},
      merchantCategoryRules: {},
    };
  }
  return normalizeSpendingOverrideStorePayload(
    JSON.parse(await readFile(fullPath, 'utf8')),
  );
}

async function writeOverrideStore(input: {
  transactionOverrides: SpendingTransactionOverrideMap;
  merchantCategoryRules: SpendingMerchantCategoryRuleMap;
}): Promise<SpendingOverrideStorePayload> {
  const payload: SpendingOverrideStorePayload = {
    schemaVersion: 'spending-overrides-v1',
    updatedAtIso: new Date().toISOString(),
    transactionOverrides: input.transactionOverrides,
    merchantCategoryRules: input.merchantCategoryRules,
  };
  const fullPath = path.resolve(SPENDING_OVERRIDES_FILE);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

async function loadAppliedRawTransactions(): Promise<SpendingTransaction[]> {
  const transactions = await loadRawTransactions();
  const overrides = await loadOverrideStore();
  return applySpendingTransactionOverrides(
    applySpendingMerchantCategoryRules(
      transactions,
      overrides.merchantCategoryRules,
    ),
    overrides.transactionOverrides,
  );
}

async function loadTransactions(): Promise<SpendingTransaction[]> {
  const transactions = await loadAppliedRawTransactions();
  return splitAmazonCreditCardTransactionsForBudget(
    transactions,
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

function transactionSummary(transaction: SpendingTransaction) {
  return {
    id: transaction.id,
    postedDate: transaction.postedDate,
    transactionDate: transaction.transactionDate ?? null,
    merchant: transaction.merchant,
    displayTitle: transaction.displayTitle ?? null,
    description: transaction.description ?? null,
    amount: transaction.amount,
    currency: transaction.currency,
    accountId: transaction.accountId ?? null,
    categoryId: transaction.categoryId ?? 'uncategorized',
    ignored: transaction.ignored === true,
    classificationMethod: transaction.classificationMethod ?? null,
    sourceKind: transaction.source?.source ?? null,
    sourceId: transaction.source?.sourceId ?? null,
  };
}

function readRequestBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64_000) {
        request.destroy(new Error('request_body_too_large'));
      }
    });
    request.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    request.on('error', reject);
  });
}

function parseOverrideBody(value: unknown, fallbackCategoryId?: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('body_must_be_object');
  }
  const body = value as SpendingOverrideRequestBody;
  const categoryId =
    fallbackCategoryId ??
    (typeof body.categoryId === 'string' ? body.categoryId.trim() : '');
  if (!categoryId || !VALID_SPENDING_CATEGORY_IDS.has(categoryId)) {
    throw new Error('invalid_category_id');
  }
  return {
    categoryId,
    title: typeof body.title === 'string' ? body.title : undefined,
    applyToMerchant: body.applyToMerchant === true,
  };
}

async function applyTransactionOverride(input: {
  transactionId: string;
  categoryId: string;
  title?: string;
  applyToMerchant: boolean;
}) {
  const rawTransactions = await loadRawTransactions();
  const transaction = rawTransactions.find((item) => item.id === input.transactionId);
  if (!transaction) return null;

  const currentStore = await loadOverrideStore();
  const transactionOverrides = {
    ...currentStore.transactionOverrides,
    [input.transactionId]: buildSpendingTransactionOverride({
      transactionId: input.transactionId,
      categoryId: input.categoryId,
      title: input.title,
    }),
  };
  const merchantCategoryRules = { ...currentStore.merchantCategoryRules };
  if (input.applyToMerchant) {
    const rule = buildSpendingMerchantCategoryRule({
      merchant: transaction.merchant,
      categoryId: input.categoryId,
    });
    merchantCategoryRules[rule.merchantKey] = rule;
  }
  const saved = await writeOverrideStore({
    transactionOverrides,
    merchantCategoryRules,
  });
  const applied = applySpendingTransactionOverrides(
    applySpendingMerchantCategoryRules([transaction], saved.merchantCategoryRules),
    saved.transactionOverrides,
  )[0];
  return {
    transaction: transactionSummary(applied),
    override: saved.transactionOverrides[input.transactionId],
    merchantRule: input.applyToMerchant
      ? Object.values(saved.merchantCategoryRules).find(
          (rule) => rule.merchantLabel === transaction.merchant,
        ) ?? null
      : null,
    updatedAtIso: saved.updatedAtIso,
  };
}

async function deleteTransactionOverride(transactionId: string) {
  const currentStore = await loadOverrideStore();
  if (!currentStore.transactionOverrides[transactionId]) return null;
  const transactionOverrides = { ...currentStore.transactionOverrides };
  delete transactionOverrides[transactionId];
  return writeOverrideStore({
    transactionOverrides,
    merchantCategoryRules: currentStore.merchantCategoryRules,
  });
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
    if (!['GET', 'POST', 'DELETE'].includes(request.method ?? '')) {
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

    if (request.method === 'GET' && url.pathname === '/api/spending/overrides') {
      writeJson(response, 200, await loadOverrideStore());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/spending/transactions') {
      const limit = Math.min(
        250,
        Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50),
      );
      const month = url.searchParams.get('month');
      const categoryId = url.searchParams.get('categoryId');
      const transactions = await loadAppliedRawTransactions();
      const filtered = transactions
        .filter((transaction) => {
          if (month && !(transaction.transactionDate ?? transaction.postedDate).startsWith(month)) {
            return false;
          }
          if (categoryId && (transaction.categoryId ?? 'uncategorized') !== categoryId) {
            return false;
          }
          return true;
        })
        .sort((left, right) => {
          const leftDate = left.transactionDate ?? left.postedDate;
          const rightDate = right.transactionDate ?? right.postedDate;
          if (rightDate !== leftDate) return rightDate.localeCompare(leftDate);
          return Math.abs(right.amount) - Math.abs(left.amount);
        })
        .slice(0, limit)
        .map(transactionSummary);
      writeJson(response, 200, {
        state: 'ok',
        count: filtered.length,
        transactions: filtered,
      });
      return;
    }

    const spendingOverrideMatch =
      /^\/api\/spending\/transactions\/([^/]+)\/override$/.exec(url.pathname);
    if (spendingOverrideMatch && request.method === 'POST') {
      const body = parseOverrideBody(await readRequestBody(request));
      const result = await applyTransactionOverride({
        transactionId: decodeURIComponent(spendingOverrideMatch[1]),
        ...body,
      });
      if (!result) {
        writeJson(response, 404, { error: 'transaction_not_found' });
        return;
      }
      writeJson(response, 200, { state: 'ok', ...result });
      return;
    }
    if (spendingOverrideMatch && request.method === 'DELETE') {
      const saved = await deleteTransactionOverride(
        decodeURIComponent(spendingOverrideMatch[1]),
      );
      if (!saved) {
        writeJson(response, 404, { error: 'override_not_found' });
        return;
      }
      writeJson(response, 200, {
        state: 'ok',
        transactionId: decodeURIComponent(spendingOverrideMatch[1]),
        updatedAtIso: saved.updatedAtIso,
      });
      return;
    }

    const spendingIgnoreMatch =
      /^\/api\/spending\/transactions\/([^/]+)\/ignore$/.exec(url.pathname);
    if (spendingIgnoreMatch && request.method === 'POST') {
      const body = parseOverrideBody(await readRequestBody(request), 'ignored');
      const result = await applyTransactionOverride({
        transactionId: decodeURIComponent(spendingIgnoreMatch[1]),
        ...body,
      });
      if (!result) {
        writeJson(response, 404, { error: 'transaction_not_found' });
        return;
      }
      writeJson(response, 200, { state: 'ok', ...result });
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
