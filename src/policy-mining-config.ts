/**
 * Shared policy-mining UI configuration.
 *
 * The trial count is part of the persisted corpus fingerprint. Keep this
 * single source of truth in sync across Mining, Cockpit, and legacy entry
 * points so post-mine recommendation lookups read the corpus the UI just
 * produced.
 *
 * Lowered from 2000 -> 1000 after the ranking-stability validator showed
 * top-20 preservation and Spearman 0.9997 across a 90-policy grid.
 */
export const POLICY_MINING_TRIAL_COUNT = 1000;
