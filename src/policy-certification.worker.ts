/// <reference lib="webworker" />

import { runPolicyCertification } from './policy-certification';
import type { SeedData } from './types';
import type {
  PolicyCertificationWorkerRequest,
  PolicyCertificationWorkerResponse,
} from './policy-certification.worker-types';

const workerScope = self as DedicatedWorkerGlobalScope;

function post(message: PolicyCertificationWorkerResponse) {
  workerScope.postMessage(message);
}

function cloneSeedData(seed: SeedData): SeedData {
  if (typeof structuredClone === 'function') {
    return structuredClone(seed);
  }
  return JSON.parse(JSON.stringify(seed)) as SeedData;
}

workerScope.onmessage = async (
  event: MessageEvent<PolicyCertificationWorkerRequest>,
) => {
  const message = event.data;
  if (message.type !== 'run') return;

  const { requestId, payload } = message;
  try {
    const pack = await runPolicyCertification({
      ...payload,
      cloner: cloneSeedData,
      onProgress: (completed, total) => {
        post({
          type: 'progress',
          requestId,
          completed,
          total,
        });
      },
    });
    post({ type: 'result', requestId, pack });
  } catch (error) {
    post({
      type: 'error',
      requestId,
      error:
        error instanceof Error
          ? error.message
          : 'Policy certification worker failed',
    });
  }
};
