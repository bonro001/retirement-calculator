import { beforeEach, describe, expect, it } from 'vitest';
import { initialSeedData } from './data';
import { useAppStore } from './store';

function resetStore() {
  useAppStore.setState((state) => ({
    ...state,
    data: structuredClone(initialSeedData),
    appliedData: structuredClone(initialSeedData),
    draftSelectedStressors: [],
    draftSelectedResponses: [],
    hasPendingSimulationChanges: false,
    draftTradeSetActivities: [],
    latestUnifiedPlanEvaluationContext: null,
  }));
}

describe('store applyAccountTradeInstructions', () => {
  beforeEach(() => {
    resetStore();
  });

  it('updates target allocation weights and marks pending changes', () => {
    const initialPretax = useAppStore.getState().data.accounts.pretax.targetAllocation;
    const beforeVtiWeight = initialPretax.VTI ?? 0;
    const beforeCashWeight = initialPretax.CASH ?? 0;

    useAppStore.getState().applyAccountTradeInstructions([
      {
        accountBucket: 'pretax',
        sourceAccountId: null,
        fromSymbol: 'VTI',
        toSymbol: 'CASH',
        dollarAmount: 1_000,
      },
    ]);

    const nextState = useAppStore.getState();
    const nextPretax = nextState.data.accounts.pretax.targetAllocation;

    expect(nextPretax.VTI).toBeLessThan(beforeVtiWeight);
    expect(nextPretax.CASH).toBeGreaterThan(beforeCashWeight);
    expect(nextState.hasPendingSimulationChanges).toBe(true);
  });

  it('updates source-account holdings when sourceAccountId is provided', () => {
    const sourceAccountId = '267425112';
    const beforeAccount = useAppStore
      .getState()
      .data.accounts.pretax.sourceAccounts?.find((account) => account.id === sourceAccountId);
    const beforeVti = beforeAccount?.holdings?.find((holding) => holding.symbol === 'VTI')?.value ?? 0;
    const beforeCash = beforeAccount?.holdings?.find((holding) => holding.symbol === 'CASH')?.value ?? 0;

    useAppStore.getState().applyAccountTradeInstructions([
      {
        accountBucket: 'pretax',
        sourceAccountId,
        fromSymbol: 'VTI',
        toSymbol: 'CASH',
        dollarAmount: 500,
      },
    ]);

    const afterAccount = useAppStore
      .getState()
      .data.accounts.pretax.sourceAccounts?.find((account) => account.id === sourceAccountId);
    const afterVti = afterAccount?.holdings?.find((holding) => holding.symbol === 'VTI')?.value ?? 0;
    const afterCash = afterAccount?.holdings?.find((holding) => holding.symbol === 'CASH')?.value ?? 0;

    expect(afterVti).toBeCloseTo(beforeVti - 500, 2);
    expect(afterCash).toBeCloseTo(beforeCash + 500, 2);
  });

  it('replaces draft data snapshot exactly for undo workflow', () => {
    const original = structuredClone(useAppStore.getState().data);
    const modified = structuredClone(original);
    modified.accounts.cash.balance += 12_345;
    modified.accounts.pretax.targetAllocation.CASH = 0.4;

    useAppStore.getState().replaceDraftData(modified);
    expect(useAppStore.getState().data.accounts.cash.balance).toBe(modified.accounts.cash.balance);
    expect(useAppStore.getState().hasPendingSimulationChanges).toBe(true);

    useAppStore.getState().replaceDraftData(original);
    expect(useAppStore.getState().data).toEqual(original);
    expect(useAppStore.getState().hasPendingSimulationChanges).toBe(false);
  });

  it('records and clears draft trade set activity for header list', () => {
    useAppStore.getState().recordDraftTradeSetActivity({
      kind: 'apply',
      actionTitle: 'Balanced pre-retirement runway reserve',
      scenarioName: 'Balanced pre-retirement runway reserve (10:45 AM)',
      instructions: [
        {
          accountBucket: 'pretax',
          sourceAccountId: '267425112',
          fromSymbol: 'VTI',
          toSymbol: 'CASH',
          dollarAmount: 1200,
        },
      ],
    });

    const recorded = useAppStore.getState().draftTradeSetActivities;
    expect(recorded.length).toBe(1);
    expect(recorded[0]?.actionTitle).toBe('Balanced pre-retirement runway reserve');
    expect(recorded[0]?.instructions[0]?.fromSymbol).toBe('VTI');

    useAppStore.getState().clearDraftTradeSetActivities();
    expect(useAppStore.getState().draftTradeSetActivities).toEqual([]);
  });

  it('updates paycheck contribution settings and marks pending changes', () => {
    const before = useAppStore.getState().data.income.preRetirementContributions;
    const beforePretax = before?.employee401kPreTaxAnnualAmount ?? before?.employee401kAnnualAmount ?? 0;

    useAppStore.getState().updatePreRetirementContribution('employee401kPreTaxAnnualAmount', 31000);
    useAppStore.getState().updatePreRetirementContribution('employee401kRothAnnualAmount', 4000);
    useAppStore.getState().updateEmployerMatchContribution(
      'maxEmployeeContributionPercentOfSalary',
      0.08,
    );

    const nextState = useAppStore.getState();
    const next = nextState.data.income.preRetirementContributions;
    expect(next?.employee401kPreTaxAnnualAmount).toBe(31000);
    expect(next?.employee401kRothAnnualAmount).toBe(4000);
    expect(next?.employerMatch?.maxEmployeeContributionPercentOfSalary).toBe(0.08);
    expect((next?.employee401kPreTaxAnnualAmount ?? 0)).not.toBe(beforePretax);
    expect(nextState.hasPendingSimulationChanges).toBe(true);
  });

  it('applies pre-retirement contribution patch for playbook actions', () => {
    useAppStore.getState().applyPreRetirementContributionPatch({
      employee401kPreTaxAnnualAmount: 32000,
      employee401kRothAnnualAmount: 0,
      hsaAnnualAmount: 8550,
    });

    const next = useAppStore.getState().data.income.preRetirementContributions;
    expect(next?.employee401kPreTaxAnnualAmount).toBe(32000);
    expect(next?.employee401kRothAnnualAmount).toBe(0);
    expect(next?.hsaAnnualAmount).toBe(8550);
    expect(useAppStore.getState().hasPendingSimulationChanges).toBe(true);
  });
});
