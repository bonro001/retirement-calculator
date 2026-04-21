import type { ClosedLoopConvergenceThresholds } from './types';

export const DEFAULT_MAX_CLOSED_LOOP_PASSES = 3;

export const DEFAULT_CLOSED_LOOP_CONVERGENCE_THRESHOLDS: ClosedLoopConvergenceThresholds = {
  magiDeltaDollars: 50,
  federalTaxDeltaDollars: 50,
  healthcarePremiumDeltaDollars: 50,
};

export type ClosedLoopStopReason =
  | 'converged_thresholds_met'
  | 'max_pass_limit_reached'
  | 'no_change';
