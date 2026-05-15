import OpenAI from 'openai';
import {
  buildMiningNorthStarAiReviewInput,
  type MiningNorthStarAiCheck,
  type MiningNorthStarAiCheckRequest,
  type MiningNorthStarAiFinding,
  type MiningNorthStarAiReviewInput,
  type MiningNorthStarAiVerdict,
  type MiningNorthStarFindingStatus,
} from '../src/mining-north-star-ai';
import type {
  PolicyEvaluation,
  PolicyMiningSessionConfig,
} from '../src/policy-miner-types';

export class MiningNorthStarAiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'MiningNorthStarAiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface RunMiningNorthStarAiCheckArgs {
  sessionId: string;
  config: PolicyMiningSessionConfig;
  evaluations: PolicyEvaluation[];
  legacyTargetTodayDollars: number;
  request?: MiningNorthStarAiCheckRequest;
  apiKey?: string;
  model?: string;
}

const DEFAULT_MODEL = 'gpt-5.4';

const VALID_VERDICTS = new Set<MiningNorthStarAiVerdict>([
  'aligned',
  'watch',
  'misaligned',
  'insufficient_data',
]);
const VALID_FINDING_STATUSES = new Set<MiningNorthStarFindingStatus>([
  'pass',
  'watch',
  'fail',
]);
const VALID_CONFIDENCE = new Set(['low', 'medium', 'high']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0);
}

function parseAiJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new MiningNorthStarAiError(
      'OpenAI returned an empty response',
      'empty_ai_response',
      502,
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
      return JSON.parse(fenced[1]);
    }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new MiningNorthStarAiError(
      'OpenAI response was not valid JSON',
      'bad_ai_json',
      502,
    );
  }
}

function sanitizeFinding(
  value: unknown,
  fallbackId: string,
): MiningNorthStarAiFinding | null {
  const r = asRecord(value);
  const statusRaw = asString(r.status, 'watch') as MiningNorthStarFindingStatus;
  const status = VALID_FINDING_STATUSES.has(statusRaw) ? statusRaw : 'watch';
  const title = asString(r.title);
  const detail = asString(r.detail);
  if (!title || !detail) return null;
  const recommendation = asString(r.recommendation);
  return {
    id: asString(r.id, fallbackId),
    status,
    title,
    detail,
    evidence: asStringArray(r.evidence),
    ...(recommendation ? { recommendation } : {}),
  };
}

function sanitizeAiPayload(
  payload: unknown,
  context: {
    input: MiningNorthStarAiReviewInput;
    model: string;
    generatedAtIso: string;
  },
): MiningNorthStarAiCheck {
  const r = asRecord(payload);
  const verdictRaw = asString(r.verdict, 'watch') as MiningNorthStarAiVerdict;
  const verdict = VALID_VERDICTS.has(verdictRaw) ? verdictRaw : 'watch';
  const confidenceRaw = asString(r.confidence, 'low');
  const confidence = VALID_CONFIDENCE.has(confidenceRaw)
    ? (confidenceRaw as 'low' | 'medium' | 'high')
    : 'low';
  const findings = Array.isArray(r.findings)
    ? r.findings
        .map((f, idx) => sanitizeFinding(f, `ai_finding_${idx + 1}`))
        .filter((f): f is MiningNorthStarAiFinding => !!f)
    : [];
  const fallbackFindings = context.input.deterministicFindings.map((f) => ({
    ...f,
    recommendation: undefined,
  }));

  return {
    version: 'mining_north_star_ai_check_v1',
    generatedAtIso: context.generatedAtIso,
    model: context.model,
    sessionId: context.input.sessionId,
    baselineFingerprint: context.input.baselineFingerprint,
    engineVersion: context.input.engineVersion,
    selectedPolicyId: context.input.corpus.selectedPolicyId,
    northStar: context.input.northStar,
    verdict,
    confidence,
    summary:
      asString(r.summary) ||
      'AI review completed, but the response did not include a summary.',
    findings: findings.length > 0 ? findings : fallbackFindings,
    actionItems: asStringArray(r.actionItems),
    deterministicInput: context.input,
  };
}

function buildPrompt(input: MiningNorthStarAiReviewInput): string {
  return `You are reviewing a retirement policy-mining corpus against this north star: leave about the stated legacy target and maximize early spending, while respecting the legacy-attainment and solvency gates.

Use only the JSON review input. Do not invent missing tax, account, or yearly-path data. If the corpus does not contain enough evidence to prove the north star, say so with verdict "watch" or "insufficient_data".

Return ONLY valid JSON with this exact top-level shape:
{
  "verdict": "aligned" | "watch" | "misaligned" | "insufficient_data",
  "confidence": "low" | "medium" | "high",
  "summary": "one short paragraph",
  "findings": [
    {
      "id": "snake_case",
      "status": "pass" | "watch" | "fail",
      "title": "short title",
      "detail": "plain-English explanation grounded in the JSON",
      "evidence": ["specific numeric evidence from the JSON"],
      "recommendation": "optional next action"
    }
  ],
  "actionItems": ["short concrete next action"]
}

Review input:
${JSON.stringify(input, null, 2)}`;
}

export async function runMiningNorthStarAiCheck({
  sessionId,
  config,
  evaluations,
  legacyTargetTodayDollars,
  request,
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.MINING_NORTH_STAR_AI_MODEL || DEFAULT_MODEL,
}: RunMiningNorthStarAiCheckArgs): Promise<MiningNorthStarAiCheck> {
  if (!apiKey) {
    throw new MiningNorthStarAiError(
      'OPENAI_API_KEY is not set for the dispatcher process',
      'missing_openai_api_key',
      503,
    );
  }

  const generatedAtIso = new Date().toISOString();
  const input = buildMiningNorthStarAiReviewInput({
    sessionId,
    config,
    evaluations,
    legacyTargetTodayDollars,
    request,
    generatedAtIso,
  });

  const client = new OpenAI({ apiKey });
  const response = await client.responses.create({
    model,
    input: buildPrompt(input),
  });
  const outputText = response.output_text;
  const payload = parseAiJson(outputText);

  return sanitizeAiPayload(payload, {
    input,
    model,
    generatedAtIso,
  });
}
