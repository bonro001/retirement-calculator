import { useAppStore } from '../store';
import { InsightCard, Panel, WithdrawalStep } from '../ui-primitives';

export function TaxesScreen() {
  const data = useAppStore((state) => state.data);

  return (
    <Panel
      title="Taxes"
      subtitle="The spec calls for tax-aware withdrawals and IRMAA awareness without a full tax engine in V1. This shell frames taxes as guidance and constraints instead of pretending exact optimization already exists."
    >
      <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="space-y-4">
          <InsightCard
            eyebrow="Planning mode"
            title={data.rules.irmaaAware ? 'IRMAA-aware routing is on.' : 'IRMAA routing is off.'}
            body="Use this panel to decide when future withdrawal heuristics should prefer taxable or cash first to keep Medicare-related income spikes manageable."
          />
          <InsightCard
            eyebrow="MVP heuristic"
            title="Use cash and taxable flexibility first when the market is weak."
            body="The initial shell is set up for practical decision support: avoid forcing pretax withdrawals at the worst possible time if cash or planned windfalls can absorb the hit."
          />
        </div>
        <article className="rounded-[28px] bg-stone-100/85 p-5">
          <p className="text-sm uppercase tracking-[0.18em] text-stone-500">
            Withdrawal order draft
          </p>
          <div className="mt-4 grid gap-3">
            <WithdrawalStep
              title="1. Cash buffer"
              body="Protects against selling risk assets into a drawdown and smooths year-to-year MAGI."
            />
            <WithdrawalStep
              title="2. Taxable bucket"
              body="Flexible for bad markets, especially when paired with lower optional spend."
            />
            <WithdrawalStep
              title="3. Pretax and Roth mix"
              body="The engine now uses a simple IRMAA-aware sequence, with room left for a later detailed tax-bracket layer."
            />
          </div>
        </article>
      </div>
    </Panel>
  );
}
