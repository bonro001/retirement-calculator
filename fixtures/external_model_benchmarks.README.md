# External Model Benchmarks

This fixture freezes outside-model observations so parity tests stay deterministic.
It is deliberately not a live scraper. Refresh the captures manually when a source
changes data vintages, tax law, or calculator behavior.

The corpus currently covers:

- FIRECalc's published 400k / 20k / 30-year / 60-40 example.
- cFIREsim live capture for the same plain historical-spending case.
- FI Calc live capture for the same plain historical-spending case.
- PolicyEngine US API capture for a simple 2026 MFJ W-2 federal-tax scenario.

The historical calculators use longer Shiller-style data windows than our local
`fixtures/historical_annual_returns.json` fixture. The tests therefore compare
success-rate bands and pin our local 1926-1994 rolling-window result separately.

For cFIREsim, see
`fixtures/cfiresim_400k_20k_30yr_60_40_export.json` and
`src/cfiresim-export-parity.test.ts`. That path freezes the hosted CSV export
at the cohort-summary level and proves the corpus row's 92 / 125 success result.

For the tighter FI Calc replay, see
`fixtures/ficalc_historical_annual_returns.json` and
`src/ficalc-source-parity.test.ts`. That path uses FI Calc's own bundled annual
data and reproduces the captured 125-cohort result directly.
