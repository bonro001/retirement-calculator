import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertRandomTape, type SimulationRandomTape } from '../src/random-tape';
import {
  assertEngineCandidateResponse,
  buildEngineCandidateRequest,
  comparePathResults,
  runEngineCompare,
  runEngineReference,
} from '../src/engine-compare';
import type { SeedData, SimulationStrategyMode, WithdrawalRule } from '../src/types';

interface CliOptions {
  trials?: number;
  mode?: SimulationStrategyMode;
  recordTapePath?: string;
  replayTapePath?: string;
  candidateCommand?: string;
  dataPath?: string;
  writeRequestPath?: string;
  writeReferencePath?: string;
  writeCandidatePath?: string;
  historical?: boolean;
  withdrawalRule?: WithdrawalRule;
  json?: boolean;
}

function readArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--trials' && next) {
      options.trials = Number(next);
      index += 1;
    } else if (arg === '--mode' && next) {
      if (next !== 'planner_enhanced' && next !== 'raw_simulation') {
        throw new Error(`Unsupported --mode ${next}`);
      }
      options.mode = next;
      index += 1;
    } else if (arg === '--record-tape' && next) {
      options.recordTapePath = next;
      index += 1;
    } else if (arg === '--replay-tape' && next) {
      options.replayTapePath = next;
      index += 1;
    } else if (arg === '--candidate-command' && next) {
      options.candidateCommand = next;
      index += 1;
    } else if (arg === '--data' && next) {
      options.dataPath = next;
      index += 1;
    } else if (arg === '--write-request' && next) {
      options.writeRequestPath = next;
      index += 1;
    } else if (arg === '--write-reference' && next) {
      options.writeReferencePath = next;
      index += 1;
    } else if (arg === '--write-candidate' && next) {
      options.writeCandidatePath = next;
      index += 1;
    } else if (arg === '--historical') {
      options.historical = true;
    } else if (arg === '--withdrawal-rule' && next) {
      if (
        next !== 'tax_bracket_waterfall' &&
        next !== 'reverse_waterfall' &&
        next !== 'proportional' &&
        next !== 'guyton_klinger'
      ) {
        throw new Error(`Unsupported --withdrawal-rule ${next}`);
      }
      options.withdrawalRule = next;
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  npm run engine:compare -- --trials 200 --mode raw_simulation --record-tape out/tape.json
  npm run engine:compare -- --trials 200 --mode raw_simulation --replay-tape out/tape.json
  npm run engine:compare -- --trials 200 --mode raw_simulation --candidate-command "node --import tsx scripts/engine-candidate-ts.ts"

Options:
  --trials <n>                  Simulation trial count. Defaults to 200.
  --mode <planner_enhanced|raw_simulation>
  --record-tape <path>          Write transformed stochastic tape JSON.
  --replay-tape <path>          Replay transformed stochastic tape JSON.
  --candidate-command <command> Compare TS reference against external process.
  --data <path>                 Read SeedData JSON from a file.
  --write-request <path>        Write candidate stdin JSON.
  --write-reference <path>      Write TS reference PathResult JSON.
  --write-candidate <path>      Write candidate response JSON.
  --historical                  Use historical bootstrap mode.
  --withdrawal-rule <rule>      tax_bracket_waterfall, reverse_waterfall, proportional, or guyton_klinger.
  --json                        Print machine-readable report JSON.`);
}

function readTape(path: string): SimulationRandomTape {
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
  assertRandomTape(parsed);
  return parsed;
}

function writeTape(path: string, tape: SimulationRandomTape) {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(tape, null, 2)}\n`);
}

function writeJson(path: string, value: unknown) {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

function numberDelta(left: unknown, right: unknown) {
  return typeof left === 'number' && typeof right === 'number'
    ? Math.abs(left - right)
    : null;
}

function valuesDiffer(left: unknown, right: unknown, tolerance = 1) {
  const delta = numberDelta(left, right);
  return delta === null ? left !== right : delta > tolerance;
}

function wealthTolerance(value: unknown) {
  return typeof value === 'number'
    ? Math.max(2, Math.abs(value) * 1e-7)
    : 2;
}

function findTrialDifference(request: ReturnType<typeof buildEngineCandidateRequest>, response: unknown) {
  const diagnostics = (response as { diagnostics?: { trials?: unknown } }).diagnostics;
  const candidateTrials = Array.isArray(diagnostics?.trials) ? diagnostics.trials : [];
  const candidateByIndex = new Map(
    candidateTrials
      .filter((trial): trial is Record<string, unknown> => Boolean(trial) && typeof trial === 'object')
      .map((trial) => [trial.trialIndex, trial]),
  );

  for (const expectedTrial of request.tape.trials) {
    const actualTrial = candidateByIndex.get(expectedTrial.trialIndex);
    if (!actualTrial) {
      return {
        field: `trial[${expectedTrial.trialIndex}]`,
        expected: 'present',
        actual: 'missing',
        delta: null,
      };
    }
    for (const field of ['success', 'failureYear']) {
      const expected = expectedTrial.reference?.[field as keyof NonNullable<typeof expectedTrial.reference>];
      const actual = actualTrial[field];
      if (valuesDiffer(expected, actual, 0)) {
        return {
          field: `trial[${expectedTrial.trialIndex}].${field}`,
          expected,
          actual,
          delta: numberDelta(expected, actual),
        };
      }
    }

    const actualYearly = Array.isArray(actualTrial.yearly) ? actualTrial.yearly : [];
    for (let index = 0; index < (expectedTrial.reference?.yearly.length ?? 0); index += 1) {
      const expectedYear = expectedTrial.reference!.yearly[index];
      const actualYear = actualYearly[index] as Record<string, unknown> | undefined;
      if (!actualYear) {
        return {
          field: `trial[${expectedTrial.trialIndex}].yearly[${index}]`,
          expected: 'present',
          actual: 'missing',
          delta: null,
        };
      }
      for (const field of [
        'year',
        'totalAssets',
        'pretaxBalanceEnd',
        'taxableBalanceEnd',
        'rothBalanceEnd',
        'cashBalanceEnd',
        'spending',
        'income',
        'federalTax',
      ]) {
        const expected = expectedYear[field as keyof typeof expectedYear];
        const actual = actualYear[field];
        const tolerance = [
          'totalAssets',
          'pretaxBalanceEnd',
          'taxableBalanceEnd',
          'rothBalanceEnd',
          'cashBalanceEnd',
        ].includes(field)
          ? wealthTolerance(expected)
          : 1;
        if (valuesDiffer(expected, actual, tolerance)) {
          return {
            field: `trial[${expectedTrial.trialIndex}].yearly[${index}].${field}`,
            expected,
            actual,
            delta: numberDelta(expected, actual),
          };
        }
      }
    }
    {
      const expected = expectedTrial.reference?.endingWealth;
      const actual = actualTrial.endingWealth;
      if (valuesDiffer(expected, actual, wealthTolerance(expected))) {
        return {
          field: `trial[${expectedTrial.trialIndex}].endingWealth`,
          expected,
          actual,
          delta: numberDelta(expected, actual),
        };
      }
    }
  }

  return null;
}

const options = readArgs(process.argv.slice(2));
const replayTape = options.replayTapePath ? readTape(options.replayTapePath) : undefined;
const data = options.dataPath
  ? JSON.parse(readFileSync(resolve(options.dataPath), 'utf8')) as SeedData
  : undefined;

const baseOptions = {
  data,
  trials: options.trials,
  mode: options.mode,
  assumptions: options.withdrawalRule
    ? { withdrawalRule: options.withdrawalRule }
    : undefined,
  replayTape,
  useHistoricalBootstrap: options.historical,
};

const report = options.candidateCommand
  ? (() => {
      const reference = runEngineReference({
        ...baseOptions,
        recordTape: !replayTape,
      });
      const request = buildEngineCandidateRequest(reference);
      if (options.writeRequestPath) {
        writeJson(options.writeRequestPath, request);
      }
      if (options.writeReferencePath) {
        writeJson(options.writeReferencePath, reference.path);
      }
      const candidateStart = performance.now();
      const child = spawnSync(options.candidateCommand!, {
        input: JSON.stringify(request),
        encoding: 'utf8',
        shell: true,
        maxBuffer: 256 * 1024 * 1024,
        timeout: 120_000,
      });
      const candidateRuntimeMs = performance.now() - candidateStart;
      if (child.error) {
        throw child.error;
      }
      if (child.signal) {
        throw new Error(`candidate command terminated by signal ${child.signal}`);
      }
      if (child.status !== 0) {
        throw new Error(
          `candidate command exited ${child.status}\nSTDERR:\n${child.stderr}\nSTDOUT:\n${child.stdout}`,
        );
      }
      const parsed = JSON.parse(child.stdout) as unknown;
      assertEngineCandidateResponse(parsed);
      if (!parsed.path) {
        throw new Error('engine:compare requires a full_trace candidate path');
      }
      if (options.writeCandidatePath) {
        writeJson(options.writeCandidatePath, parsed);
      }
      const comparison = comparePathResults(reference.path, parsed.path);
      const trialDifference = findTrialDifference(request, parsed);
      return {
        ...comparison,
        pass: comparison.pass && trialDifference === null,
        referenceRuntimeMs: reference.runtimeMs,
        candidateRuntimeMs,
        recordedTape: reference.tape,
        summary: {
          mode: reference.mode,
          trials: reference.assumptions.simulationRuns,
          successRate: reference.path.successRate,
          medianEndingWealth: reference.path.medianEndingWealth,
          p10EndingWealth: reference.path.endingWealthPercentiles.p10,
          p90EndingWealth: reference.path.endingWealthPercentiles.p90,
        },
        trialDifference,
        candidateRuntime: parsed.runtime,
        candidateDiagnostics: parsed.diagnostics,
      };
    })()
  : runEngineCompare({
      ...baseOptions,
      recordTape: Boolean(options.recordTapePath),
    });

if (options.recordTapePath && report.recordedTape) {
  writeTape(options.recordTapePath, report.recordedTape);
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`engine:compare pass=${report.pass}`);
  console.log(
    `mode=${report.summary.mode} trials=${report.summary.trials} success=${(
      report.summary.successRate * 100
    ).toFixed(1)}% medianEW=$${Math.round(report.summary.medianEndingWealth).toLocaleString()}`,
  );
  console.log(
    `timing reference=${report.referenceRuntimeMs.toFixed(1)}ms replay=${report.candidateRuntimeMs.toFixed(1)}ms checked=${report.checkedFields}`,
  );
  if ('candidateRuntime' in report && report.candidateRuntime) {
    console.log(`candidateRuntime=${report.candidateRuntime}`);
  }
  if (options.recordTapePath && report.recordedTape) {
    console.log(`recordedTape=${resolve(options.recordTapePath)}`);
  }
  if (report.firstDifference) {
    console.log('firstDifference=');
    console.log(JSON.stringify(report.firstDifference, null, 2));
  }
  if ('trialDifference' in report && report.trialDifference) {
    console.log('trialDifference=');
    console.log(JSON.stringify(report.trialDifference, null, 2));
  }
}

process.exit(report.pass ? 0 : 1);
