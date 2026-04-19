import type { PlanningStateExport } from './planning-export';
import type { ParityHarnessExpectedValues } from './monte-carlo-parity';
import {
  formatParityHarnessReport,
  runParityConvergenceFromExport,
  runParityHarnessFromExport,
} from './monte-carlo-parity';

export interface ParityHarnessScriptOutput {
  summary: ReturnType<typeof runParityHarnessFromExport>;
  convergence: ReturnType<typeof runParityConvergenceFromExport>;
  reportText: string;
}

export function runParityHarnessScript(
  exportPayload: PlanningStateExport,
  expected?: ParityHarnessExpectedValues,
): ParityHarnessScriptOutput {
  const summary = runParityHarnessFromExport(exportPayload, expected);
  const convergence = runParityConvergenceFromExport(exportPayload, [5000, 10000, 25000]);
  const reportText = formatParityHarnessReport(summary);

  return {
    summary,
    convergence,
    reportText,
  };
}

export function runParityHarnessScriptFromJson(
  exportJson: string,
  expected?: ParityHarnessExpectedValues,
) {
  const exportPayload = JSON.parse(exportJson) as PlanningStateExport;
  return runParityHarnessScript(exportPayload, expected);
}
