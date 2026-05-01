import type { DecisionEngineReport } from './decision-engine';
import type { RecommendationConstraints } from './decision-engine';
import type { MarketAssumptions, PathResult, SeedData } from './types';

export interface DecisionEngineWorkerRunPayload {
  requestId: string;
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  strategyMode: 'raw_simulation' | 'planner_enhanced';
  simulationRunsOverride: number;
  seedBase: number;
  constraints?: RecommendationConstraints;
}

export type DecisionEngineWorkerRequest =
  | { type: 'run'; payload: DecisionEngineWorkerRunPayload }
  | { type: 'cancel'; requestId: string };

export type DecisionEngineWorkerResponse =
  | {
      type: 'result';
      requestId: string;
      baselinePath: PathResult;
      report: DecisionEngineReport;
    }
  | {
      type: 'error';
      requestId: string;
      error: string;
    }
  | {
      type: 'cancelled';
      requestId: string;
    };
