import { buildPlanningStateExportWithResolvedContext } from './planning-export';
import type {
  PlanningExportWorkerRequest,
  PlanningExportWorkerResponse,
} from './planning-export-worker-types';

self.onmessage = async (event: MessageEvent<PlanningExportWorkerRequest>) => {
  const message = event.data;
  if (message.type !== 'run') {
    return;
  }

  try {
    const assumptionsForExport = {
      ...message.payload.assumptions,
      simulationRuns: Math.min(message.payload.assumptions.simulationRuns, 150),
    };
    const payload = await buildPlanningStateExportWithResolvedContext({
      data: message.payload.data,
      assumptions: assumptionsForExport,
      selectedStressorIds: message.payload.selectedStressorIds,
      selectedResponseIds: message.payload.selectedResponseIds,
      exportMode: message.payload.exportMode,
      unifiedPlanEvaluation: message.payload.unifiedPlanEvaluation,
      unifiedPlanEvaluationCapturedAtIso: message.payload.unifiedPlanEvaluationCapturedAtIso,
    });
    const response: PlanningExportWorkerResponse = {
      type: 'result',
      requestId: message.payload.requestId,
      payload,
    };
    self.postMessage(response);
  } catch (error) {
    const response: PlanningExportWorkerResponse = {
      type: 'error',
      requestId: message.payload.requestId,
      error: error instanceof Error ? error.message : 'Export generation failed.',
    };
    self.postMessage(response);
  }
};
