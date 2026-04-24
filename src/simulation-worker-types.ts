import type {
  MarketAssumptions,
  PathResult,
  SeedData,
  SimulationParityReport,
} from './types';
/** Condensed spend-solver output used for the sandbox hero + smile curve. */
export interface SolvedSpendProfile {
  /** Max sustainable constant-real monthly spend at the configured success target. */
  monthlySpendNow: number;
  /** Retirement-smile phase numbers (monthly, real dollars), post-floor. */
  monthly60s: number;
  monthly70s: number;
  monthly80Plus: number;
  /** Raw per-phase solver output BEFORE clamping to the guaranteed-income floor. */
  rawMonthly60s: number;
  rawMonthly70s: number;
  rawMonthly80Plus: number;
  /** Guaranteed Social Security income floor for each phase (monthly, real). */
  floorMonthly60s: number;
  floorMonthly70s: number;
  floorMonthly80Plus: number;
  /** Success target used for the solve (e.g. 0.85). */
  successTarget: number;
  /** Actual success achieved at the recommended spend. */
  achievedSuccess: number;
}

export interface SimulationStressorKnobsPayload {
  delayedInheritanceYears?: number;
  cutSpendingPercent?: number;
  layoffRetireDate?: string;
  layoffSeverance?: number;
}

export interface SimulationRunPayload {
  requestId: string;
  data: SeedData;
  assumptions: MarketAssumptions;
  selectedStressors: string[];
  selectedResponses: string[];
  stressorKnobs?: SimulationStressorKnobsPayload;
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
      /** Solved constant-real spend profile for the sandbox scenario. */
      solvedSpendProfile: SolvedSpendProfile | null;
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
