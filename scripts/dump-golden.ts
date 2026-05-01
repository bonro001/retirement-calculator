import { runGoldenScenarios } from '../src/verification-harness';
import { GOLDEN_SCENARIOS } from '../src/verification-scenarios';
const reports = runGoldenScenarios(GOLDEN_SCENARIOS);
for (const r of reports) {
  console.log(`\n=== ${r.scenarioId} (pass=${r.pass}) ===`);
  for (const c of r.comparisons) {
    console.log(
      `  ${c.pass ? 'OK  ' : 'FAIL'} ${c.metric}: expected=${c.expected} actual=${c.actual} delta=${c.delta} tol=${c.tolerance}`,
    );
  }
  for (const note of r.notes) {
    console.log(`  NOTE ${note}`);
  }
}
