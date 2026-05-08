import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  assertEngineCandidateResponse,
  type EngineCandidateRequest,
  type EngineCandidateResponse,
} from '../src/engine-compare';
import {
  packSummaryRandomTape,
  type CompactSummaryRandomTape,
} from '../src/compact-random-tape';
import type { SimulationRandomTape } from '../src/random-tape';
import type { PolicyMiningSummary } from '../src/policy-mining-summary-contract';
import type { RustEngineClientTiming } from './rust-engine-client';

interface NativeFlightEngineAddon {
  runCandidateRequestJson: (requestJson: string) => string;
  runCandidateSummaryCompactJson?: (
    requestWithoutTapeJson: string,
    tapeMetadataJson: string,
    trialIndex: Int32Array,
    trialSeed: Float64Array,
    ltcEventOccurs: Uint8Array,
    cashflowPresent: Uint8Array,
    marketState: Uint8Array,
    marketYears: Float64Array,
    yearFieldCount: number,
  ) => string;
  registerCandidateSummaryCompactTapeJson?: (
    sessionId: string,
    tapeMetadataJson: string,
    trialIndex: Int32Array,
    trialSeed: Float64Array,
    ltcEventOccurs: Uint8Array,
    cashflowPresent: Uint8Array,
    marketState: Uint8Array,
    marketYears: Float64Array,
    yearFieldCount: number,
  ) => string;
  runCandidateSummaryCompactSessionJson?: (
    requestWithoutTapeJson: string,
    sessionId: string,
  ) => string;
  clearCandidateSummaryCompactTapeJson?: (sessionId: string) => string;
}

export const DEFAULT_RUST_NATIVE_ADDON_PATH =
  'flight-engine-rs/target/release/flight_engine_napi.node';

function loadNativeAddon(path = process.env.FLIGHT_ENGINE_NATIVE_ADDON): NativeFlightEngineAddon {
  const require = createRequire(import.meta.url);
  const addonPath = resolve(path ?? DEFAULT_RUST_NATIVE_ADDON_PATH);
  const addon = require(addonPath) as Partial<NativeFlightEngineAddon>;
  if (typeof addon.runCandidateRequestJson !== 'function') {
    throw new Error(
      `Rust native addon at ${addonPath} does not export runCandidateRequestJson(requestJson)`,
    );
  }
  return {
    runCandidateRequestJson: addon.runCandidateRequestJson,
    runCandidateSummaryCompactJson: addon.runCandidateSummaryCompactJson,
    registerCandidateSummaryCompactTapeJson:
      addon.registerCandidateSummaryCompactTapeJson,
    runCandidateSummaryCompactSessionJson:
      addon.runCandidateSummaryCompactSessionJson,
    clearCandidateSummaryCompactTapeJson:
      addon.clearCandidateSummaryCompactTapeJson,
  };
}

interface CompactTapeCacheEntry {
  compactTape: CompactSummaryRandomTape;
  nativeSessionId?: string;
}

export class NativeRustEngineClient {
  private readonly addon: NativeFlightEngineAddon;
  private readonly compactTapeCache = new WeakMap<
    SimulationRandomTape,
    CompactTapeCacheEntry
  >();
  private readonly nativeSessionIds = new Set<string>();
  private nextNativeSessionId = 1;

  constructor(addon?: NativeFlightEngineAddon) {
    this.addon = addon ?? loadNativeAddon();
  }

  runCandidateRequest(request: EngineCandidateRequest): EngineCandidateResponse {
    const requestJson = JSON.stringify(request);
    const responseJson = this.addon.runCandidateRequestJson(requestJson);
    const parsed = JSON.parse(responseJson) as unknown;
    assertEngineCandidateResponse(parsed);
    return parsed;
  }

  runCandidateRequestWithTiming(request: EngineCandidateRequest): {
    response: EngineCandidateResponse;
    timings: RustEngineClientTiming;
  } {
    const serializeStartedAt = performance.now();
    const requestJson = JSON.stringify(request);
    const requestSerializeDurationMs = performance.now() - serializeStartedAt;

    const nativeStartedAt = performance.now();
    const responseJson = this.addon.runCandidateRequestJson(requestJson);
    const responseWaitDurationMs = performance.now() - nativeStartedAt;

    const parseStartedAt = performance.now();
    const parsed = JSON.parse(responseJson) as unknown;
    const responseParseDurationMs = performance.now() - parseStartedAt;
    assertEngineCandidateResponse(parsed);

    return {
      response: parsed,
      timings: {
        requestSerializeDurationMs,
        requestBytes: Buffer.byteLength(requestJson, 'utf8'),
        ipcWriteDurationMs: 0,
        responseWaitDurationMs,
        responseParseDurationMs,
        responseBytes: Buffer.byteLength(responseJson, 'utf8'),
        totalDurationMs:
          requestSerializeDurationMs + responseWaitDurationMs + responseParseDurationMs,
      },
    };
  }

  runPolicyMiningSummary(request: EngineCandidateRequest): PolicyMiningSummary {
    const response = this.runCandidateRequest({
      ...request,
      outputLevel: 'policy_mining_summary',
    });
    if (!response.summary) {
      throw new Error('Rust native summary response is missing summary');
    }
    return response.summary;
  }

  runPolicyMiningSummaryWithTiming(request: EngineCandidateRequest): {
    summary: PolicyMiningSummary;
    timings: RustEngineClientTiming;
  } {
    const { response, timings } = this.runCandidateRequestWithTiming({
      ...request,
      outputLevel: 'policy_mining_summary',
    });
    if (!response.summary) {
      throw new Error('Rust native summary response is missing summary');
    }
    return { summary: response.summary, timings };
  }

  runPolicyMiningSummaryCompactWithTiming(request: EngineCandidateRequest): {
    summary: PolicyMiningSummary;
    timings: RustEngineClientTiming;
    diagnostics?: EngineCandidateResponse['diagnostics'];
  } {
    if (typeof this.addon.runCandidateSummaryCompactJson !== 'function') {
      throw new Error(
        'Rust native addon does not export runCandidateSummaryCompactJson',
      );
    }
    const serializeStartedAt = performance.now();
    let cacheEntry = this.compactTapeCache.get(request.tape);
    const compactTapeCacheHit = Boolean(cacheEntry);
    if (!cacheEntry) {
      cacheEntry = { compactTape: packSummaryRandomTape(request.tape) };
      this.compactTapeCache.set(request.tape, cacheEntry);
    }
    const compactTape = cacheEntry.compactTape;
    const requestWithoutTape: Partial<EngineCandidateRequest> = {
      ...request,
      outputLevel: 'policy_mining_summary' as const,
    };
    delete requestWithoutTape.tape;
    const requestJson = JSON.stringify(requestWithoutTape);
    const tapeMetadataJson = JSON.stringify(compactTape.metadata);
    const tapeBytes =
      Buffer.byteLength(tapeMetadataJson, 'utf8') +
      compactTape.trialIndex.byteLength +
      compactTape.trialSeed.byteLength +
      compactTape.ltcEventOccurs.byteLength +
      compactTape.cashflowPresent.byteLength +
      compactTape.marketState.byteLength +
      compactTape.marketYears.byteLength;
    let sessionIdBytes = 0;
    let requestBytes = Buffer.byteLength(requestJson, 'utf8') + tapeBytes;
    let responseJson: string;
    const supportsNativeTapeSessions =
      typeof this.addon.registerCandidateSummaryCompactTapeJson === 'function' &&
      typeof this.addon.runCandidateSummaryCompactSessionJson === 'function';
    if (supportsNativeTapeSessions) {
      cacheEntry.nativeSessionId ??=
        `compact-tape-${process.pid}-${this.nextNativeSessionId++}`;
      const sessionId = cacheEntry.nativeSessionId;
      sessionIdBytes = Buffer.byteLength(sessionId, 'utf8');
      if (!compactTapeCacheHit) {
        this.addon.registerCandidateSummaryCompactTapeJson!(
          sessionId,
          tapeMetadataJson,
          compactTape.trialIndex,
          compactTape.trialSeed,
          compactTape.ltcEventOccurs,
          compactTape.cashflowPresent,
          compactTape.marketState,
          compactTape.marketYears,
          compactTape.yearFieldCount,
        );
        this.nativeSessionIds.add(sessionId);
      }
      requestBytes =
        Buffer.byteLength(requestJson, 'utf8') +
        sessionIdBytes +
        (compactTapeCacheHit ? 0 : tapeBytes);
    }
    const requestSerializeDurationMs = performance.now() - serializeStartedAt;

    const nativeStartedAt = performance.now();
    if (supportsNativeTapeSessions && cacheEntry.nativeSessionId) {
      responseJson = this.addon.runCandidateSummaryCompactSessionJson!(
        requestJson,
        cacheEntry.nativeSessionId,
      );
    } else {
      responseJson = this.addon.runCandidateSummaryCompactJson(
        requestJson,
        tapeMetadataJson,
        compactTape.trialIndex,
        compactTape.trialSeed,
        compactTape.ltcEventOccurs,
        compactTape.cashflowPresent,
        compactTape.marketState,
        compactTape.marketYears,
        compactTape.yearFieldCount,
      );
    }
    const responseWaitDurationMs = performance.now() - nativeStartedAt;

    const parseStartedAt = performance.now();
    const parsed = JSON.parse(responseJson) as unknown;
    const responseParseDurationMs = performance.now() - parseStartedAt;
    assertEngineCandidateResponse(parsed);
    if (!parsed.summary) {
      throw new Error('Rust native compact summary response is missing summary');
    }

    return {
      summary: parsed.summary,
      diagnostics: parsed.diagnostics,
      timings: {
        requestSerializeDurationMs,
        requestBytes,
        candidateRequestTapeBytes:
          supportsNativeTapeSessions && compactTapeCacheHit ? 0 : tapeBytes,
        candidateRequestTapeBytesSaved:
          supportsNativeTapeSessions && compactTapeCacheHit ? tapeBytes : 0,
        candidateRequestEnvelopeBytes: Math.max(
          0,
          requestBytes -
            (supportsNativeTapeSessions && compactTapeCacheHit ? 0 : tapeBytes),
        ),
        compactTapeCacheHits: compactTapeCacheHit ? 1 : 0,
        compactTapeCacheMisses: compactTapeCacheHit ? 0 : 1,
        ipcWriteDurationMs: 0,
        responseWaitDurationMs,
        responseParseDurationMs,
        responseBytes: Buffer.byteLength(responseJson, 'utf8'),
        totalDurationMs:
          requestSerializeDurationMs + responseWaitDurationMs + responseParseDurationMs,
      },
    };
  }

  async close(): Promise<void> {
    if (typeof this.addon.clearCandidateSummaryCompactTapeJson !== 'function') {
      this.nativeSessionIds.clear();
      return;
    }
    for (const sessionId of this.nativeSessionIds) {
      this.addon.clearCandidateSummaryCompactTapeJson(sessionId);
    }
    this.nativeSessionIds.clear();
  }
}
