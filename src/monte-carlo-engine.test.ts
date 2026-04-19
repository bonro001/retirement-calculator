import { describe, expect, it } from 'vitest';
import { executeDeterministicMonteCarlo } from './monte-carlo-engine';

describe('monte-carlo-engine', () => {
  it('is reproducible for the same seed and trials', () => {
    const runInput = {
      seed: 98765,
      trialCount: 50,
      assumptionsVersion: 'unit-test',
      runTrial: ({ random }: { random: () => number }) => {
        const first = random();
        const second = random();
        const endingWealth = Math.round((first * 1000000 + second * 100000) * 100) / 100;
        return {
          success: endingWealth > 400000,
          endingWealth,
          failureYear: endingWealth > 400000 ? null : 2035,
        };
      },
      summarizeTrial: (result: { success: boolean; endingWealth: number; failureYear: number | null }) => result,
    };

    const firstRun = executeDeterministicMonteCarlo(runInput);
    const secondRun = executeDeterministicMonteCarlo(runInput);

    expect(secondRun).toEqual(firstRun);
  });

  it('changes outputs when seed changes', () => {
    const runForSeed = (seed: number) =>
      executeDeterministicMonteCarlo({
        seed,
        trialCount: 30,
        assumptionsVersion: 'unit-test',
        runTrial: ({ random }: { random: () => number }) => {
          const endingWealth = random() * 1000000;
          return {
            success: endingWealth >= 500000,
            endingWealth,
            failureYear: endingWealth >= 500000 ? null : 2032,
          };
        },
        summarizeTrial: (result: { success: boolean; endingWealth: number; failureYear: number | null }) =>
          result,
      });

    const firstSeedRun = runForSeed(1);
    const secondSeedRun = runForSeed(2);

    expect(firstSeedRun.medianEndingWealth).not.toBe(secondSeedRun.medianEndingWealth);
  });
});

