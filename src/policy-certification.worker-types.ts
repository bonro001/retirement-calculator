import type { PolicyCertificationPack } from './policy-certification';
import type {
  Policy,
  PolicySpendingScheduleBasis,
} from './policy-miner-types';
import type { MarketAssumptions, SeedData } from './types';

export interface PolicyCertificationWorkerPayload {
  policy: Policy;
  baseline: SeedData;
  assumptions: MarketAssumptions;
  baselineFingerprint: string;
  engineVersion: string;
  legacyTargetTodayDollars: number;
  spendingScheduleBasis?: PolicySpendingScheduleBasis | null;
}

export interface PolicyCertificationRunRequest {
  type: 'run';
  requestId: string;
  payload: PolicyCertificationWorkerPayload;
}

export type PolicyCertificationWorkerRequest = PolicyCertificationRunRequest;

export interface PolicyCertificationProgressResponse {
  type: 'progress';
  requestId: string;
  completed: number;
  total: number;
}

export interface PolicyCertificationResultResponse {
  type: 'result';
  requestId: string;
  pack: PolicyCertificationPack;
}

export interface PolicyCertificationErrorResponse {
  type: 'error';
  requestId: string;
  error: string;
}

export type PolicyCertificationWorkerResponse =
  | PolicyCertificationProgressResponse
  | PolicyCertificationResultResponse
  | PolicyCertificationErrorResponse;
