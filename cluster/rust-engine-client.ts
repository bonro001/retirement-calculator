import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import {
  assertEngineCandidateResponse,
  type EngineCandidateRequest,
  type EngineCandidateResponse,
} from '../src/engine-compare';
import type { PolicyMiningSummary } from '../src/policy-mining-summary-contract';

export const DEFAULT_RUST_ENGINE_COMMAND =
  'flight-engine-rs/target/release/engine_candidate --stdio-loop';

export interface RustEngineClientOptions {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RustEngineClientTiming {
  requestSerializeDurationMs: number;
  requestBytes: number;
  candidateRequestDataBytes?: number;
  candidateRequestAssumptionsBytes?: number;
  candidateRequestTapeBytes?: number;
  candidateRequestTapeBytesSaved?: number;
  candidateRequestEnvelopeBytes?: number;
  compactTapeCacheHits?: number;
  compactTapeCacheMisses?: number;
  ipcWriteDurationMs: number;
  responseWaitDurationMs: number;
  responseParseDurationMs: number;
  responseBytes: number;
  totalDurationMs: number;
}

export class RustEngineClient {
  readonly command: string;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdout: Interface;
  private readonly stderr: string[] = [];
  private pending:
    | {
        resolve: (line: string) => void;
        reject: (error: Error) => void;
      }
    | null = null;
  private closedError: Error | null = null;

  constructor(options: RustEngineClientOptions = {}) {
    this.command = options.command ?? DEFAULT_RUST_ENGINE_COMMAND;
    this.child = spawn(this.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this.stderr.push(String(chunk)));
    this.stdout = createInterface({ input: this.child.stdout });
    this.stdout.on('line', (line) => {
      const pending = this.pending;
      this.pending = null;
      pending?.resolve(line);
    });
    this.child.once('error', (error) => this.closeWithError(error));
    this.child.once('exit', (code, signal) => {
      this.closeWithError(
        new Error(
          `Rust engine exited code=${String(code)} signal=${String(signal)}${this.formatStderr()}`,
        ),
      );
    });
  }

  async runCandidateRequest(
    request: EngineCandidateRequest,
  ): Promise<EngineCandidateResponse> {
    const { line } = await this.sendJsonLineWithTiming(request);
    const parsed = JSON.parse(line) as unknown;
    assertEngineCandidateResponse(parsed);
    return parsed;
  }

  async runCandidateRequestWithTiming(
    request: EngineCandidateRequest,
  ): Promise<{
    response: EngineCandidateResponse;
    timings: RustEngineClientTiming;
  }> {
    const { line, timings } = await this.sendJsonLineWithTiming(request);
    const parseStartedAt = performance.now();
    const parsed = JSON.parse(line) as unknown;
    const responseParseDurationMs = performance.now() - parseStartedAt;
    assertEngineCandidateResponse(parsed);
    return {
      response: parsed,
      timings: {
        ...timings,
        responseParseDurationMs,
        responseBytes: Buffer.byteLength(line, 'utf8'),
        totalDurationMs:
          timings.requestSerializeDurationMs +
          timings.ipcWriteDurationMs +
          timings.responseWaitDurationMs +
          responseParseDurationMs,
      },
    };
  }

  async runPolicyMiningSummary(
    request: EngineCandidateRequest,
  ): Promise<PolicyMiningSummary> {
    const response = await this.runCandidateRequest({
      ...request,
      outputLevel: 'policy_mining_summary',
    });
    if (!response.summary) {
      throw new Error('Rust engine summary response is missing summary');
    }
    return response.summary;
  }

  async runPolicyMiningSummaryWithTiming(
    request: EngineCandidateRequest,
  ): Promise<{
    summary: PolicyMiningSummary;
    timings: RustEngineClientTiming;
  }> {
    const { response, timings } = await this.runCandidateRequestWithTiming({
      ...request,
      outputLevel: 'policy_mining_summary',
    });
    if (!response.summary) {
      throw new Error('Rust engine summary response is missing summary');
    }
    return { summary: response.summary, timings };
  }

  async close(): Promise<void> {
    this.stdout.close();
    this.child.stdin.end();
    if (this.child.exitCode === null && !this.child.killed) {
      this.child.kill();
    }
  }

  private async sendJsonLineWithTiming(
    request: EngineCandidateRequest,
  ): Promise<{
    line: string;
    timings: Omit<
      RustEngineClientTiming,
      'responseParseDurationMs' | 'responseBytes' | 'totalDurationMs'
    >;
  }> {
    if (this.closedError) {
      throw this.closedError;
    }
    if (this.pending) {
      throw new Error('RustEngineClient supports one in-flight request at a time');
    }
    const linePromise = new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    const serializeStartedAt = performance.now();
    const payload = `${JSON.stringify(request)}\n`;
    const requestSerializeDurationMs = performance.now() - serializeStartedAt;
    const writeStartedAt = performance.now();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.child.stdin.off('drain', onDrain);
        reject(error);
      };
      const onDrain = () => {
        this.child.stdin.off('error', onError);
        resolve();
      };
      this.child.stdin.once('error', onError);
      const accepted = this.child.stdin.write(payload, () => {
        this.child.stdin.off('error', onError);
        if (accepted) {
          resolve();
        }
      });
      if (!accepted) {
        this.child.stdin.once('drain', onDrain);
      }
    });
    const ipcWriteDurationMs = performance.now() - writeStartedAt;
    const responseWaitStartedAt = performance.now();
    const line = await linePromise;
    const responseWaitDurationMs = performance.now() - responseWaitStartedAt;
    return {
      line,
      timings: {
        requestSerializeDurationMs,
        requestBytes: Buffer.byteLength(payload, 'utf8'),
        ipcWriteDurationMs,
        responseWaitDurationMs,
      },
    };
  }

  private closeWithError(error: Error) {
    if (!this.closedError) {
      this.closedError = error;
    }
    const pending = this.pending;
    this.pending = null;
    pending?.reject(this.closedError);
  }

  private formatStderr() {
    const stderr = this.stderr.join('');
    return stderr ? `\n${stderr}` : '';
  }
}
