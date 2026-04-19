import type { Plan, PlanEvaluation } from './plan-evaluation';

export interface PlanAnalysisRunPayload {
  requestId: string;
  plan: Plan;
  previousEvaluation?: PlanEvaluation | null;
}

export type PlanAnalysisWorkerRequest =
  | {
      type: 'run';
      payload: PlanAnalysisRunPayload;
    }
  | {
      type: 'cancel';
      requestId: string;
    };

export type PlanAnalysisWorkerResponse =
  | {
      type: 'result';
      requestId: string;
      evaluation: PlanEvaluation;
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
