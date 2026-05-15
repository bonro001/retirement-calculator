import { parentPort } from 'node:worker_threads';
import { runPolicyCertification } from '../src/policy-certification';
import type { SeedData } from '../src/types';
import type {
  PolicyCertificationWorkerRequest,
  PolicyCertificationWorkerResponse,
} from '../src/policy-certification.worker-types';

if (!parentPort) {
  throw new Error('cluster/certify-worker.ts must be loaded as a worker_thread');
}

const port = parentPort;

function post(message: PolicyCertificationWorkerResponse): void {
  port.postMessage(message);
}

function cloneSeedData(seed: SeedData): SeedData {
  if (typeof structuredClone !== 'function') {
    throw new Error('certify-worker: structuredClone unavailable - Node 17+ required');
  }
  return structuredClone(seed);
}

port.on('message', async (message: PolicyCertificationWorkerRequest) => {
  if (message.type !== 'run') return;
  const { requestId, payload } = message;
  try {
    const pack = await runPolicyCertification({
      ...payload,
      cloner: cloneSeedData,
      onProgress: (completed, total) => {
        post({ type: 'progress', requestId, completed, total });
      },
      yieldEveryMs: 1,
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
});
