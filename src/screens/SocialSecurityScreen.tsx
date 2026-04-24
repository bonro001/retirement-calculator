import { useAppStore } from '../store';
import { InsightCard, Panel } from '../ui-primitives';
import { formatCurrency, getSocialSecurityBenefitFactor } from '../utils';

function birthYear(isoDate: string): number {
  return new Date(isoDate).getFullYear();
}

function birthMonthLabel(isoDate: string): string {
  return new Date(isoDate).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

function claimDateLabel(birthIso: string, claimAge: number): string {
  const birth = new Date(birthIso);
  const claim = new Date(birth);
  claim.setFullYear(birth.getFullYear() + claimAge);
  return claim.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

type PersonView = {
  name: string;
  birthIso: string;
  claimAge: number;
  fraMonthly: number;
  factor: number;
  adjustedMonthly: number;
  claimDate: string;
};

export function SocialSecurityScreen() {
  const data = useAppStore((state) => state.data);

  const robBirth = data.household.robBirthDate;
  const debbieBirth = data.household.debbieBirthDate;

  const entries = data.income.socialSecurity;

  const people: PersonView[] = entries.map((entry) => {
    const birthIso = entry.person === 'rob' ? robBirth : debbieBirth;
    const factor = getSocialSecurityBenefitFactor(entry.claimAge);
    return {
      name: entry.person === 'rob' ? 'Rob' : 'Debbie',
      birthIso,
      claimAge: entry.claimAge,
      fraMonthly: entry.fraMonthly,
      factor,
      adjustedMonthly: entry.fraMonthly * factor,
      claimDate: claimDateLabel(birthIso, entry.claimAge),
    };
  });

  const combinedMonthly = people.reduce((sum, p) => sum + p.adjustedMonthly, 0);
  const combinedAnnual = combinedMonthly * 12;

  // Survivor rule: surviving spouse keeps the HIGHER of the two benefits,
  // not both. That's the standard SSA "widow(er)'s benefit" simplification.
  const survivorScenarios = people.map((survivor) => {
    const deceased = people.find((p) => p.name !== survivor.name);
    const survivorOwn = survivor.adjustedMonthly;
    const deceasedBenefit = deceased?.adjustedMonthly ?? 0;
    const survivorKeeps = Math.max(survivorOwn, deceasedBenefit);
    const drop = combinedMonthly - survivorKeeps;
    const dropPercent = combinedMonthly === 0 ? 0 : drop / combinedMonthly;
    return {
      survivor,
      deceased,
      survivorKeeps,
      drop,
      dropPercent,
    };
  });

  return (
    <Panel
      title="Social Security"
      subtitle="When each of you claims, what the combined check looks like, and what survives if one of you is gone."
    >
      <div className="mb-6 rounded-[28px] border border-emerald-200 bg-emerald-50/70 p-5">
        <p className="text-xs uppercase tracking-[0.18em] text-emerald-700">
          Combined household Social Security at full claim
        </p>
        <h3 className="mt-2 text-4xl font-semibold text-emerald-900">
          {formatCurrency(Math.round(combinedMonthly))}/mo
        </h3>
        <p className="mt-1 text-sm text-emerald-900/80">
          {formatCurrency(Math.round(combinedAnnual))}/yr in today's dollars — this is your
          income floor once both of you have claimed.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {people.map((person) => {
          const earlyOrLate =
            person.claimAge < 67
              ? `claiming ${67 - person.claimAge} yr early · ${Math.round((1 - person.factor) * 100)}% haircut`
              : person.claimAge > 67
                ? `delayed ${person.claimAge - 67} yr · +${Math.round((person.factor - 1) * 100)}% uplift`
                : 'at Full Retirement Age';
          return (
            <article
              key={person.name}
              className="rounded-[28px] bg-stone-100/85 p-5"
            >
              <p className="text-xs uppercase tracking-[0.18em] text-stone-500">
                {person.name}
              </p>
              <h4 className="mt-2 text-2xl font-semibold text-stone-900">
                Claims at {person.claimAge} → {person.claimDate}
              </h4>
              <p className="mt-1 text-sm text-stone-600">
                Born {birthMonthLabel(person.birthIso)} ({birthYear(person.birthIso)}). {earlyOrLate}.
              </p>
              <div className="mt-4 space-y-1 text-sm text-stone-700">
                <p>
                  FRA benefit: <span className="font-semibold">{formatCurrency(person.fraMonthly)}/mo</span>
                </p>
                <p>
                  At claim age {person.claimAge}:{' '}
                  <span className="font-semibold text-stone-900">
                    {formatCurrency(Math.round(person.adjustedMonthly))}/mo
                  </span>
                </p>
              </div>
            </article>
          );
        })}
      </div>

      <section className="mt-8">
        <p className="text-xs uppercase tracking-[0.18em] text-stone-500">
          What if one of us dies first
        </p>
        <h3 className="mt-1 text-xl font-semibold text-stone-900">
          Survivor check
        </h3>
        <p className="mt-2 text-sm text-stone-600">
          Social Security pays the surviving spouse the <em>higher</em> of the two
          benefits, not both. Here's what's left on the table in each case.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {survivorScenarios.map((scenario) => (
            <InsightCard
              key={scenario.survivor.name}
              eyebrow={`If ${scenario.deceased?.name ?? 'spouse'} dies first`}
              title={`${scenario.survivor.name} keeps ${formatCurrency(
                Math.round(scenario.survivorKeeps),
              )}/mo`}
              body={`Household SS drops by ${formatCurrency(
                Math.round(scenario.drop),
              )}/mo (${Math.round(scenario.dropPercent * 100)}% of the combined check). ${
                scenario.deceased
                  ? `${scenario.survivor.name}'s own benefit is ${formatCurrency(
                      Math.round(scenario.survivor.adjustedMonthly),
                    )}/mo; ${scenario.deceased.name}'s was ${formatCurrency(
                      Math.round(scenario.deceased.adjustedMonthly),
                    )}/mo. The survivor keeps whichever is larger.`
                  : ''
              }`}
            />
          ))}
        </div>
        <p className="mt-4 text-xs text-stone-500">
          Survivor-scenario impact on plan success will arrive alongside the death-of-spouse stressor — this tab currently shows the SS-only arithmetic.
        </p>
      </section>
    </Panel>
  );
}
