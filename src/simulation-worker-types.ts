import type {
  MarketAssumptions,
  PathResult,
  SeedData,
  SimulationParityReport,
} from './types';

export interface SimulationRunPayload {
  requestId: string;
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
}

export type SimulationWorkerRequest =
  | {
      type: 'run';
      payload: SimulationRunPayload;
    }
  | {
      type: 'cancel';
      requestId: string;
    };

export type SimulationWorkerResponse =
  | {
      type: 'progress';
      requestId: string;
      progress: number;
    }
  | {
      type: 'result';
      requestId: string;
      pathResults: PathResult[];
      parityReport: SimulationParityReport;
    }
  | {
      type: 'cancelled';
      requestId: string;
    }
  | {
      type: 'error';
      requestId: string;
      error: string;
    };
