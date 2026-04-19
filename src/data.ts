import seedData from '../seed-data.json';
import type { ResponseOption, SeedData, Stressor } from './types';

const requiredStressors: Stressor[] = [
  {
    id: 'delayed_inheritance',
    name: 'Delayed Inheritance',
    type: 'timing',
  },
];

const requiredResponses: ResponseOption[] = [
  {
    id: 'preserve_roth',
    name: 'Preserve Roth',
  },
  {
    id: 'increase_cash_buffer',
    name: 'Increase Cash Buffer',
  },
];

function withRequiredById<T extends { id: string }>(items: T[], required: T[]) {
  const seen = new Set(items.map((item) => item.id));
  const appended = required.filter((item) => !seen.has(item.id));
  return [...items, ...appended];
}

function normalizeSeedData(input: SeedData): SeedData {
  return {
    ...input,
    stressors: withRequiredById(input.stressors, requiredStressors),
    responses: withRequiredById(input.responses, requiredResponses),
  };
}

export const initialSeedData = normalizeSeedData(seedData as SeedData);
