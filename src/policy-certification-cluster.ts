/**
 * Browser client for cluster-side policy certification.
 *
 * Mirrors the pattern of `runClusterMonthlyReviewAiApproval` in
 * `policy-mining-cluster.ts`: the browser POSTs a self-contained
 * certification job to the dispatcher, which fans it out to an
 * available host running `runPolicyCertification` in Node. The host
 * uses the Node-side JS engine — substantially faster than browser
 * web workers due to V8 + no throttling + 8 worker threads.
 *
 * Callers can decide whether to fall back when the dispatcher is
 * unreachable. Monthly Review treats the host path as required so
 * certification does not pin the browser renderer.
 */

import { clusterUrlToHttp } from './policy-mining-cluster';
import type { PolicyCertificationPack } from './policy-certification';
import type { Policy, PolicySpendingScheduleBasis } from './policy-miner-types';
import type { MarketAssumptions, SeedData } from './types';

export interface ClusterCertifyInput {
  policy: Policy;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  legacyTargetTodayDollars: number;
  spendingScheduleBasis?: PolicySpendingScheduleBasis | null;
}

export interface ClusterCertifyOptions {
  onAssigned?: (host: {
    peerId: string;
    displayName: string;
    certifyCapacity: number;
  }) => void;
  onProgress?: (completed: number, total: number) => void;
}

export class ClusterCertifyError extends Error {
  readonly code:
    | 'unreachable'
    | 'no_host'
    | 'timeout'
    | 'http_error'
    | 'bad_payload';
  readonly statusCode: number | null;
  constructor(
    message: string,
    code: ClusterCertifyError['code'],
    statusCode: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * POST <dispatcher>/certify with the certification payload. Resolves with
 * the deterministic certification pack. Rejects with `ClusterCertifyError`
 * tagged so the call site can decide whether to fall back to a browser
 * worker (e.g. on `unreachable` / `no_host`).
 */
export async function runClusterCertification(
  dispatcherUrl: string,
  input: ClusterCertifyInput,
  options: ClusterCertifyOptions = {},
): Promise<PolicyCertificationPack> {
  const origin = clusterUrlToHttp(dispatcherUrl);
  const url = `${origin}/certify`;
  const body = {
    policy: input.policy,
    baseline: input.baseline,
    assumptions: input.assumptions,
    baselineFingerprint: input.baselineFingerprint,
    engineVersion: input.engineVersion,
    legacyTargetTodayDollars: input.legacyTargetTodayDollars,
    spendingScheduleBasis: input.spendingScheduleBasis ?? null,
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        ...(options.onProgress ? { Accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ClusterCertifyError(
      `cannot reach dispatcher at ${origin} — is it running?`,
      'unreachable',
      null,
      { cause: err },
    );
  }
  if (options.onProgress) {
    return readStreamingCertificationResponse(res, {
      onAssigned: options.onAssigned,
      onProgress: options.onProgress,
    });
  }
  if (res.status === 503) {
    throw new ClusterCertifyError(
      'no host available for certification',
      'no_host',
      503,
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      const payload = await res.json();
      if (payload && typeof payload === 'object' && 'detail' in payload) {
        detail = ` — ${String((payload as { detail?: unknown }).detail)}`;
      }
    } catch {
      // Non-JSON body; keep the generic status line.
    }
    throw new ClusterCertifyError(
      `dispatcher returned ${res.status} for /certify${detail}`,
      'http_error',
      res.status,
    );
  }
  let parsed: { pack?: PolicyCertificationPack };
  try {
    parsed = (await res.json()) as { pack?: PolicyCertificationPack };
  } catch (err) {
    throw new ClusterCertifyError(
      'dispatcher returned non-JSON body for /certify',
      'bad_payload',
      res.status,
      { cause: err },
    );
  }
  if (!parsed.pack) {
    throw new ClusterCertifyError(
      'dispatcher returned no pack on /certify response',
      'bad_payload',
      res.status,
    );
  }
  return parsed.pack;
}

async function readStreamingCertificationResponse(
  res: Response,
  options: Required<Pick<ClusterCertifyOptions, 'onProgress'>> &
    Pick<ClusterCertifyOptions, 'onAssigned'>,
): Promise<PolicyCertificationPack> {
  if (!res.ok) {
    throw new ClusterCertifyError(
      `dispatcher returned ${res.status} for streaming /certify`,
      res.status === 503 ? 'no_host' : 'http_error',
      res.status,
    );
  }
  if (!res.body) {
    throw new ClusterCertifyError(
      'dispatcher returned no stream body for /certify',
      'bad_payload',
      res.status,
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pack: PolicyCertificationPack | null = null;

  const processBlock = (block: string): void => {
    if (!block.trim()) return;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
    if (event === 'progress') {
      const completed = Number(data.completed);
      const total = Number(data.total);
      if (Number.isFinite(completed) && Number.isFinite(total)) {
        options.onProgress(completed, total);
      }
      return;
    }
    if (event === 'assigned') {
      const peerId = typeof data.peerId === 'string' ? data.peerId : '';
      const displayName =
        typeof data.displayName === 'string' ? data.displayName : 'worker host';
      const certifyCapacity = Number(data.certifyCapacity);
      options.onAssigned?.({
        peerId,
        displayName,
        certifyCapacity: Number.isFinite(certifyCapacity) ? certifyCapacity : 1,
      });
      return;
    }
    if (event === 'result') {
      pack = data.pack as PolicyCertificationPack;
      return;
    }
    if (event === 'error') {
      const detail =
        typeof data.detail === 'string' ? data.detail : 'certification failed';
      throw new ClusterCertifyError(
        detail,
        data.error === 'no_host_available' ? 'no_host' : 'http_error',
        data.error === 'no_host_available' ? 503 : 500,
      );
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        processBlock(block);
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    processBlock(buffer);
  } catch (err) {
    if (err instanceof ClusterCertifyError) throw err;
    throw new ClusterCertifyError(
      'dispatcher returned invalid streaming /certify payload',
      'bad_payload',
      res.status,
      { cause: err },
    );
  }

  if (!pack) {
    throw new ClusterCertifyError(
      'dispatcher stream ended without certification result',
      'bad_payload',
      res.status,
    );
  }
  return pack;
}
