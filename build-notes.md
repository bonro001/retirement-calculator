# Build Notes

## Stack
- React
- TypeScript
- Tailwind CSS
- Recharts
- Zustand (or simple context)

## App Structure

### Layout
- Left sidebar (navigation)
- Top summary bar
- Main content area
- Right drawer for edits

---

## Core Domain Model

- BasePlan
- Stressor
- Response
- Path
- PathResult

---

## Key Feature: Path Engine

Each path is:

BasePlan + Stressor(s) + Response(s)

Generate combinations dynamically.

---

## Core Components

- SummaryStatCard
- PathComparisonTable
- ScenarioSelector
- EditableField
- StressTestCard
- InsightCard
- Chart components

---

## Charts

- SuccessProbabilityChart
- NetWorthProjectionChart
- IncomeVsSpendingChart
- FailureDistributionChart

---

## Build Order

1. App shell (layout + navigation)
2. Load seed-data.json
3. Build Path Comparison screen (static data first)
4. Add editable inputs (spending, retirement date, etc.)
5. Add stressor/response selection
6. Build simulation placeholder
7. Add Monte Carlo engine
8. Add insights panel

---

## Simulation (V1)

- Simple Monte Carlo
- Annual returns
- Adjustable mean + volatility
- Overlay stress scenarios

---

## UX Rules

- Default to comparison view
- Always show "what changed"
- Prefer plain English over charts when possible
- Avoid overwhelming inputs

---

## Data Persistence

- Local JSON file
- No backend needed for V1
- Replace mode for imports

---

## Future Enhancements

- IRMAA detailed modeling
- Tax brackets
- Withdrawal optimization engine
- Historical backtesting
- Multi-user support
