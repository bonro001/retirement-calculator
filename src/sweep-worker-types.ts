import type { MarketAssumptions, PathResult, SeedData } from './types';

/**
 * One point in a sweep. The worker runs buildPathResults once for this point
 * in 'selected_only' mode and returns the single PathResult.
 */
export interface SweepPointInput {
  pointId: string;
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  strategyMode: 'raw_simulation' | 'planner_enhanced';
  /**
   * Optional per-year spend override. When provided, the worker passes it
   * through to buildPathResults as `annualSpendScheduleByYear` so Trade
   * Builder-style purchase/reduction scenarios can run in the pool too.
   */
  annualSpendScheduleByYear?: Record<number, number>;
}

export interface SweepRunPayload {
  batchId: string;
  points: SweepPointInput[];
}

export type SweepWorkerRequest =
  | { type: 'run'; payload: SweepRunPayload }
  | { type: 'cancel'; batchId: string };

export type SweepWorkerResponse =
  | {
      type: 'point';
      batchId: string;
      pointId: string;
      index: number;
      total: number;
      path: PathResult;
    }
  | {
      type: 'progress';
      batchId: string;
      pointId: string;
      index: number;
      total: number;
      pointProgress: number;
    }
  | {
      type: 'done';
      batchId: string;
    }
  | {
      type: 'cancelled';
      batchId: string;
    }
  | {
      type: 'error';
      batchId: string;
      error: string;
    };
