import { useAppStore } from '../store';
import { InsightCard, Panel } from '../ui-primitives';
import { formatCurrency, formatDate } from '../utils';

export function IncomeScreen() {
  const data = useAppStore((state) => state.data);

  return (
    <Panel
      title="Income"
      subtitle="This view shows the income timeline that powers the plan. Salary end date, Social Security claim ages, and windfall timing are all editable from the drawer."
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <article className="rounded-[28px] bg-stone-100/85 p-5">
          <p className="text-sm uppercase tracking-[0.18em] text-stone-500">Salary</p>
          <h3 className="mt-2 text-3xl font-semibold text-stone-900">
            {formatCurrency(data.income.salaryAnnual)}
          </h3>
          <p className="mt-3 text-sm text-stone-600">
            Active until {formatDate(data.income.salaryEndDate)}.
          </p>
        </article>

        <article className="rounded-[28px] bg-stone-100/85 p-5">
          <p className="text-sm uppercase tracking-[0.18em] text-stone-500">
            Social Security
          </p>
          <div className="mt-4 space-y-4">
            {data.income.socialSecurity.map((item) => (
              <div key={item.person} className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium capitalize text-stone-800">{item.person}</p>
                  <p className="text-sm text-stone-500">Claim age {item.claimAge}</p>
                </div>
                <p className="text-lg font-semibold text-stone-900">
                  {formatCurrency(item.fraMonthly)}/mo
                </p>
              </div>
            ))}
          </div>
        </article>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {data.income.windfalls.map((item) => (
          <InsightCard
            key={item.name}
            eyebrow={`Windfall ${item.year}`}
            title={`${item.name.replaceAll('_', ' ')}: ${formatCurrency(item.amount)}`}
            body="Windfalls are modeled as explicit decision support levers rather than assumed guarantees, so delayed-arrival stress tests can be layered on later."
          />
        ))}
      </div>
    </Panel>
  );
}
