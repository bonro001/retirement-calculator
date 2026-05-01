import { NativeRustEngineClient } from '../cluster/rust-engine-native-client';
import {
  buildEngineCandidateRequest,
  comparePathResults,
  runEngineReference,
} from '../src/engine-compare';
import {
  comparePolicyMiningSummaries,
  pathToPolicyMiningSummary,
} from '../src/policy-mining-summary-contract';

const reference = runEngineReference({
  trials: 20,
  mode: 'raw_simulation',
  recordTape: true,
});

const client = new NativeRustEngineClient();
const request = buildEngineCandidateRequest(reference);
const { response, timings } = client.runCandidateRequestWithTiming(request);

if (!response.path) {
  throw new Error('Native Rust smoke expected a full_trace path response');
}

const comparison = comparePathResults(reference.path, response.path);
if (!comparison.pass) {
  throw new Error(
    `Native Rust smoke mismatch: ${JSON.stringify(comparison.firstDifference, null, 2)}`,
  );
}
const compactSummary = client.runPolicyMiningSummaryCompactWithTiming(request);
const compactComparison = comparePolicyMiningSummaries(
  pathToPolicyMiningSummary(reference.path),
  compactSummary.summary,
);
if (!compactComparison.pass) {
  throw new Error(
    `Native Rust compact summary mismatch: ${JSON.stringify(compactComparison.firstDifference, null, 2)}`,
  );
}

console.log(
  JSON.stringify(
    {
      runtime: response.runtime,
      pass: comparison.pass,
      compactSummaryPass: compactComparison.pass,
      timings,
      compactTimings: compactSummary.timings,
    },
    null,
    2,
  ),
);
