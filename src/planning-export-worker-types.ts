import type { MarketAssumptions, SeedData } from './types';
import type { PlanEvaluation } from './plan-evaluation';
import type { PlanningExportMode, PlanningStateExport } from './planning-export';

export interface PlanningExportWorkerPayload {
  requestId: string;
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressorIds: string[];
  selectedResponseIds: string[];
  exportMode?: PlanningExportMode;
  unifiedPlanEvaluation: PlanEvaluation | null;
  unifiedPlanEvaluationCapturedAtIso: string | null;
}

export type PlanningExportWorkerRequest = {
  type: 'run';
  payload: PlanningExportWorkerPayload;
};

export type PlanningExportWorkerResponse =
  | {
      type: 'result';
      requestId: string;
      payload: PlanningStateExport;
    }
  | {
      type: 'error';
      requestId: string;
      error: string;
    };
