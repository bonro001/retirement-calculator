# Retirement Autopilot System

## Goal
Build a retirement planning engine that:
- runs Monte Carlo simulations
- models taxes, IRMAA, ACA
- supports scenario sensitivity analysis
- distinguishes between faithful and reconstructed models

## Core Concepts
- Scenario = assumptions + results
- Model completeness = whether all inputs are explicitly defined
- Sensitivity analysis = multiple runs with perturbed assumptions

## Model Fidelity
- **Faithful** = all required inputs explicitly provided, no inferred assumptions
- **Reconstructed** = one or more inputs inferred or approximated
- All missing or inferred assumptions must be explicitly tracked and surfaced

## Simulation Requirements
- Monte Carlo simulations must be deterministic (seeded)
- All assumptions must be explicit or flagged as inferred
- Scenario sensitivity analysis is required (base + perturbed runs)
- Simulation outputs must include intermediate calculations where possible

## Priorities
1. Structured data over narrative
2. Deterministic reproducibility (seeded simulations)
3. Transparency of assumptions
4. Explainability of results

## Development Rules
- Never rely on inferred assumptions without flagging them
- Always store simulation outputs in structured form
- Always include a `modelCompleteness` indicator
- Always expose intermediate calculations (not just final results)
- Never hide assumptions inside logic
- Prefer TypeScript interfaces for all data structures
