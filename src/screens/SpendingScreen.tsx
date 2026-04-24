import { useAppStore } from '../store';
import { InsightCard, MetricTile, Panel } from '../ui-primitives';
import { formatCurrency, formatDate } from '../utils';

export function SpendingScreen({
  annualCoreSpend,
  annualStretchSpend,
  retirementDate,
}: {
  annualCoreSpend: number;
  annualStretchSpend: number;
  retirementDate: string;
}) {
  const data = useAppStore((state) => state.data);

  return (
    <Panel
      title="Spending"
      subtitle="The spending model is deliberately small: essential, optional, taxes and insurance, plus an early-retirement travel bump. That keeps experiments fast while still matching the way you think about tradeoffs."
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Essential"
          value={`${formatCurrency(data.spending.essentialMonthly)}/mo`}
        />
        <MetricTile
          label="Optional"
          value={`${formatCurrency(data.spending.optionalMonthly)}/mo`}
        />
        <MetricTile
          label="Taxes + insurance"
          value={`${formatCurrency(data.spending.annualTaxesInsurance)}/yr`}
        />
        <MetricTile
          label="Travel phase"
          value={`${formatCurrency(data.spending.travelEarlyRetirementAnnual)}/yr`}
        />
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <InsightCard
          eyebrow="Core spend"
          title={`${formatCurrency(annualCoreSpend)} yearly before travel.`}
          body="This acts as the stable planning floor and keeps stress tests from overstating the amount you can realistically cut."
        />
        <InsightCard
          eyebrow="Early retirement phase"
          title={`${formatCurrency(annualStretchSpend)} yearly with travel included.`}
          body={`The shell assumes the higher travel phase begins around retirement on ${formatDate(retirementDate)} and can be scaled down as a response when paths turn fragile.`}
        />
      </div>
    </Panel>
  );
}
