# Retirement Path Comparison App

## Goal
A local-first responsive retirement planning app focused on:
- Path comparison (not just static scenarios)
- Tax-aware withdrawals
- Monte Carlo simulation
- Stress testing
- Preserving optionality

## Core Concept

Base Plan + Stressors + Responses = Paths

The app evaluates whether decisions (responses) create or reduce risk across different external conditions (stressors).

## Primary User Goals
- Don’t run out of money
- Minimize regret
- Stay under IRMAA thresholds when practical
- Preserve flexibility / optionality

## Key Idea

This is not a “financial planner.”

This is a **decision engine**:
> “If I do X, will I get trapped if Y also happens?”

---

## Core Objects

### Base Plan
User’s primary retirement plan.

### Stressors
External events:
- Laid off early
- Bad first 3 years (sequence risk)
- Strong early market
- Inflation spike
- Delayed inheritance

### Responses
User decisions:
- Retire early
- Delay retirement
- Cut optional spending
- Sell home early
- Claim SS earlier/later
- Preserve Roth
- Increase cash buffer

### Paths
Combination of:
- Base Plan
- 0–2 Stressors
- 0–3 Responses

---

## Main Screens

### 1. Overview
- Success %
- Years funded
- IRMAA exposure
- Plain-English summary
- Key risks
- Key levers

---

### 2. Path Comparison (CORE SCREEN)

Compare combinations like:

| Path | Success | End Wealth | IRMAA | Corner Risk | Notes |
|------|--------|------------|--------|--------------|--------|
| Baseline | 84% | $1.2M | Medium | Medium | stable |
| Laid Off + Market Down | 58% | $320K | Low | High | fragile |
| + Cut Spending | 71% | $520K | Low | Medium | improved |
| + Sell Home Early | 79% | $690K | Medium | Low | strong |

---

### 3. Accounts
Simplified bucket model:
- Pretax
- Roth
- Taxable
- Cash

---

### 4. Spending
- Essential
- Optional
- Travel (early retirement)
- Phase-based spending

---

### 5. Income
- Salary end
- Social Security
- Windfalls
- Home sale

---

### 6. Taxes
- IRMAA awareness
- Withdrawal priority
- Estimated tax exposure

---

### 7. Stress Tests
Editable stress scenarios:
- Market crashes
- Inflation
- Layoffs
- Delays

---

### 8. Simulation
- Monte Carlo
- Custom market regimes
- Result distributions

---

### 9. Insights
Plain-English outputs:
- Biggest risks
- Best levers
- What changed

---

## Metrics

### Required Outputs
- Success rate
- Median ending wealth
- Failure timing
- IRMAA exposure

### Custom Metrics

#### Corner Risk
How dependent the plan is on favorable conditions.

#### Flexibility Score
How many viable recovery options remain.

#### Failure Mode
Primary reason the plan fails.

---

## V1 Scope

### Include
- Path comparison grid
- Editable base plan
- Basic stressors
- Basic responses
- Monte Carlo (simple)
- Plain-English insights

### Exclude (for now)
- Full tax engine
- Live account syncing
- Lot-level tax modeling
- Authentication
- Multi-user

---

## Design Principles

- Fast iteration over precision
- Minimal inputs
- Maximum insight
- Plain English over financial jargon
- Comparison-first UI
