# Peer-planner fixture template

Scaffold for adding a third (or fourth) peer-planner parity harness alongside [boldin_lower_returns.README.md](./boldin_lower_returns.README.md) and [fidelity_baseline.README.md](./fidelity_baseline.README.md). Use this as the starting point when capturing a scenario from Projection Lab, NewRetirement, FICalc, or any other tool that can analyze the same household.

## Why a third peer matters

Two-tool triangulation (Boldin vs Fidelity) revealed that a 47pp success-rate gap between them was entirely methodology (Boldin Conservative preset vs Fidelity historical bootstrap), not modeling error. A third tool:

- Breaks ties when two tools disagree.
- Detects blind spots that Fidelity and Boldin happen to share (e.g., if both under-model sequence risk in a specific way, we wouldn't know without a third reference).
- Gives the calibration dataset (CALIBRATION_WORKPLAN.md step 10) three points per refresh instead of two.

## Recommended third tools

| Tool | Strength | Weakness |
|---|---|---|
| **Projection Lab** | Published methodology, explicit MC settings, fat-tail options | Paid, may need account |
| **NewRetirement (Boldin's parent)** | Deepest tax + estate modeling | Risk of methodological overlap with Boldin itself |
| **FICalc** | Free, open-source, historical-only (no forward MC) | Different MC structure — useful as a "pure historical" anchor |
| **Personal Capital / Empower** | Automatic portfolio import | Limited projection controls |
| **cFIREsim** | Highly configurable, open-source | Enthusiast-aimed UI |

For a single-user plan focused on tail-risk trust, **FICalc** as a pure-historical anchor alongside Fidelity (historical MC) and our engine (bootstrap MC) is the strongest triangulation.

## Fixture shape

Mirror [fidelity_baseline.json](./fidelity_baseline.json) — the JSON schema is peer-tool-agnostic by design. Required fields:

```jsonc
{
  "$meta": {
    "source": "<tool name + URL>",
    "scenario": "<the scenario label as shown in the tool>",
    "methodology": "<what the tool publishes: MC trial count, return source, correlation, etc.>",
    "capturedOn": "YYYY-MM-DD",
    "capturedFrom": "<screenshots or PDF export>",
    "note": "<anything peer-specific worth flagging>"
  },
  "household": { /* you / spouse ages, retirement age, plan-to ages, filing, state */ },
  "income": { /* salary, SS claim strategy if shown */ },
  "portfolio": {
    "totalBalance": 0,
    "assetMixPct": { "domesticStock": 0, "foreignStock": 0, "bonds": 0, "shortTerm": 0, "other": 0, "unknown": 0 }
  },
  "expenses": { /* essentialMonthly, nonEssentialMonthly, totalMonthly, longTermCareAnnual */ },
  "expected": {
    "probabilityOfSuccessPct": 0,
    "totalLifetimeIncome": 0,
    "assetsRemainingTenthPercentile": 0,
    "currentSavingsBalance": 0
  }
}
```

## Translator shape

Mirror [src/fidelity-fixture-translator.ts](../src/fidelity-fixture-translator.ts). Key decisions:

- If the tool uses **historical bootstrap** or similar (Fidelity, most consumer tools): set `useHistoricalBootstrap: true` in `buildAssumptions` and reuse the 1926-2023 fixture.
- If the tool uses a **per-account override** (Boldin): set the specific mean + stdev from the tool's Rate Inspector / equivalent.
- If the tool uses **fat-tail / Student-t**: we don't currently support a t-distribution sampler (open BACKLOG item). Best approximation: historical bootstrap.

## Parity test shape

Mirror [src/fidelity-parity.test.ts](../src/fidelity-parity.test.ts). The diagnostic console output IS the main artifact — it prints Fidelity / Boldin / Ours / PeerTool in a side-by-side table. Add a fourth column and a new comparison row for the peer tool's specific outputs.

## Adoption workflow

1. Plug the household into the peer tool. Snapshot the summary screen (or PDF export).
2. Copy [fidelity_baseline.json](./fidelity_baseline.json) to `fixtures/peer_<tool_name>_baseline.json`; fill in the peer tool's numbers.
3. Copy [src/fidelity-fixture-translator.ts](../src/fidelity-fixture-translator.ts) to `src/peer-<tool_name>-fixture-translator.ts`; adjust methodology flags.
4. Copy [src/fidelity-parity.test.ts](../src/fidelity-parity.test.ts) to `src/peer-<tool_name>-parity.test.ts`; update labels + imports.
5. Run the test — the diagnostic output goes into [docs/testing.md](../docs/testing.md) as another triangulation data point.

No change to the engine or seed data should be required to adopt a new peer.
