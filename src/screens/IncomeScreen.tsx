import { useAppStore } from '../store';
import { Panel } from '../ui-primitives';
import { formatCurrency, formatDate } from '../utils';
import { WindfallEditor } from './WindfallEditor';

export function IncomeScreen() {
  const data = useAppStore((state) => state.data);
  const hasPendingSimulationChanges = useAppStore(
    (state) => state.hasPendingSimulationChanges,
  );
  const commitDraftToApplied = useAppStore((state) => state.commitDraftToApplied);
  const requestUnifiedPlanRerun = useAppStore(
    (state) => state.requestUnifiedPlanRerun,
  );

  const applyAndRerun = () => {
    commitDraftToApplied();
    requestUnifiedPlanRerun();
  };

  return (
    <Panel
      title="Income"
      subtitle="This view shows the income timeline that powers the plan. Salary end date, Social Security claim ages, and windfall timing are all editable from the drawer."
    >
      {hasPendingSimulationChanges ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-blue-200 bg-blue-50/80 px-4 py-3 text-sm text-blue-900">
          <span>Income changes are staged in the draft plan.</span>
          <button
            type="button"
            onClick={applyAndRerun}
            className="rounded-full bg-blue-700 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-600"
          >
            Apply to plan &amp; rerun
          </button>
        </div>
      ) : null}
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

      <div className="mt-6">
        <WindfallEditor />
      </div>
    </Panel>
  );
}
