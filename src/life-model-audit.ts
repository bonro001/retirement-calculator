import type { MarketAssumptions, SeedData, WindfallDeploymentPolicy, WindfallEntry } from './types';

export type LifeModelAuditStatus = 'explicit' | 'inferred' | 'missing';
export type LifeModelEventKind =
  | 'salary'
  | 'social_security'
  | 'windfall'
  | 'home_sale'
  | 'spending'
  | 'withdrawal'
  | 'tax'
  | 'healthcare'
  | 'scheduled_outflow';
export type LifeModelEventReviewStatus = 'pass' | 'watch' | 'fail';
export type LifeModelEventMateriality = 'high' | 'medium' | 'low';

export interface LifeModelAuditStep {
  id:
    | 'source'
    | 'timing'
    | 'amount'
    | 'tax_treatment'
    | 'destination'
    | 'spending_use'
    | 'investment_policy'
    | 'future_return_treatment';
  status: LifeModelAuditStatus;
  detail: string;
  evidence: string[];
}

export interface LifeModelAuditEvent {
  id: string;
  kind: LifeModelEventKind;
  title: string;
  year: number | null;
  amountTodayDollars: number | null;
  materiality: LifeModelEventMateriality;
  reviewStatus: LifeModelEventReviewStatus;
  steps: LifeModelAuditStep[];
  reviewerQuestion: string;
}

export interface LifeModelAudit {
  version: 'life_model_audit_v1';
  generatedAtIso: string;
  modelCompleteness: 'faithful' | 'reconstructed';
  unresolvedEventCount: number;
  materialUnresolvedEventCount: number;
  events: LifeModelAuditEvent[];
  reviewerChecklist: string[];
}

interface BuildLifeModelAuditInput {
  data: SeedData;
  assumptions: MarketAssumptions;
  generatedAtIso: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validDate(value: string) {
  return !Number.isNaN(new Date(value).getTime());
}

function moneyEvidence(label: string, value: number | null | undefined) {
  return isFiniteNumber(value) ? `${label}=${Math.round(value)}` : `${label}=missing`;
}

function reviewStatusFor(
  materiality: LifeModelEventMateriality,
  steps: LifeModelAuditStep[],
): LifeModelEventReviewStatus {
  const hasMissing = steps.some((step) => step.status === 'missing');
  if (hasMissing && (materiality === 'high' || materiality === 'medium')) {
    return 'fail';
  }
  const hasInferred = steps.some((step) => step.status === 'inferred');
  return hasMissing || hasInferred ? 'watch' : 'pass';
}

function buildEvent(input: Omit<LifeModelAuditEvent, 'reviewStatus'>): LifeModelAuditEvent {
  return {
    ...input,
    reviewStatus: reviewStatusFor(input.materiality, input.steps),
  };
}

function defaultedWindfallDeploymentPolicy(
  policy: WindfallDeploymentPolicy | undefined,
): Required<Omit<WindfallDeploymentPolicy, 'assumptionSource'>> &
  Pick<WindfallDeploymentPolicy, 'assumptionSource'> {
  return {
    enabled: policy?.enabled ?? true,
    destinationAccount: policy?.destinationAccount ?? 'taxable',
    investmentPolicy: policy?.investmentPolicy ?? 'current_portfolio_mix',
    trackingMode: policy?.trackingMode ?? 'taxable_shadow_sleeve',
    spendBeforeDeploy: policy?.spendBeforeDeploy ?? true,
    cashReserveMonths: Math.max(0, policy?.cashReserveMonths ?? 0),
    assumptionSource: policy?.assumptionSource,
  };
}

function taxTreatmentStep(windfall: WindfallEntry): LifeModelAuditStep {
  if (!windfall.taxTreatment) {
    return {
      id: 'tax_treatment',
      status: 'missing',
      detail:
        'Tax treatment is not explicit, so the engine must infer whether this is cash, ordinary income, LTCG, home-sale gain, or inherited IRA income.',
      evidence: [`windfall=${windfall.name}`, 'taxTreatment=missing'],
    };
  }

  if (windfall.taxTreatment === 'primary_home_sale') {
    const missing = [
      isFiniteNumber(windfall.costBasis) ? null : 'costBasis',
      isFiniteNumber(windfall.exclusionAmount) ? null : 'exclusionAmount',
      isFiniteNumber(windfall.sellingCostPercent) ? null : 'sellingCostPercent',
    ].filter((item): item is string => item !== null);
    return {
      id: 'tax_treatment',
      status: missing.length ? 'inferred' : 'explicit',
      detail: missing.length
        ? `Primary-home-sale tax treatment is present, but ${missing.join(
            ', ',
          )} is still inferred or defaulted.`
        : 'Primary-home-sale tax treatment includes basis, exclusion, and selling-cost assumptions.',
      evidence: [
        `taxTreatment=${windfall.taxTreatment}`,
        moneyEvidence('costBasis', windfall.costBasis),
        moneyEvidence('exclusionAmount', windfall.exclusionAmount),
        `sellingCostPercent=${windfall.sellingCostPercent ?? 'missing'}`,
      ],
    };
  }

  if (windfall.taxTreatment === 'inherited_ira_10y') {
    return {
      id: 'tax_treatment',
      status: isFiniteNumber(windfall.distributionYears) ? 'explicit' : 'inferred',
      detail: isFiniteNumber(windfall.distributionYears)
        ? 'Inherited IRA treatment and distribution horizon are explicit.'
        : 'Inherited IRA treatment is explicit, but the 10-year distribution horizon is defaulted.',
      evidence: [
        `taxTreatment=${windfall.taxTreatment}`,
        `distributionYears=${windfall.distributionYears ?? 'default_10'}`,
      ],
    };
  }

  return {
    id: 'tax_treatment',
    status: 'explicit',
    detail: `Windfall tax treatment is explicitly modeled as ${windfall.taxTreatment}.`,
    evidence: [`taxTreatment=${windfall.taxTreatment}`],
  };
}

function windfallTimingStep(windfall: WindfallEntry): LifeModelAuditStep {
  if (windfall.certainty === 'uncertain' || windfall.certainty === 'estimated') {
    return {
      id: 'timing',
      status: 'inferred',
      detail: `Timing and amount are modeled, but the event is marked ${windfall.certainty}.`,
      evidence: [
        `year=${windfall.year}`,
        `certainty=${windfall.certainty}`,
        `timingUncertaintyYears=${windfall.timingUncertaintyYears ?? 0}`,
        `amountUncertaintyPercent=${windfall.amountUncertaintyPercent ?? 0}`,
      ],
    };
  }

  return {
    id: 'timing',
    status: windfall.certainty === 'certain' ? 'explicit' : 'inferred',
    detail:
      windfall.certainty === 'certain'
        ? 'Timing certainty is explicitly marked as certain.'
        : 'The event year is present, but certainty is not explicitly labeled.',
    evidence: [`year=${windfall.year}`, `certainty=${windfall.certainty ?? 'missing'}`],
  };
}

function windfallLiquidityStep(windfall: WindfallEntry): LifeModelAuditStep {
  if (windfall.taxTreatment !== 'primary_home_sale') {
    return {
      id: 'amount',
      status: isFiniteNumber(windfall.amount) ? 'explicit' : 'missing',
      detail: 'Gross windfall amount is the modeled cash source.',
      evidence: [moneyEvidence('amount', windfall.amount)],
    };
  }

  const hasExplicitLiquidity = isFiniteNumber(windfall.liquidityAmount);
  const hasReplacementModel =
    isFiniteNumber(windfall.replacementHomeCost) &&
    isFiniteNumber(windfall.purchaseClosingCostPercent) &&
    isFiniteNumber(windfall.movingCost);
  return {
    id: 'amount',
    status: hasExplicitLiquidity || hasReplacementModel ? 'explicit' : 'missing',
    detail:
      hasExplicitLiquidity || hasReplacementModel
        ? 'Home-sale cash available to the plan is explicit through liquidity or replacement-home assumptions.'
        : 'Home sale exists, but investable cash is not explicit; gross sale proceeds could be mistaken for available portfolio cash.',
    evidence: [
      moneyEvidence('amount', windfall.amount),
      moneyEvidence('liquidityAmount', windfall.liquidityAmount),
      moneyEvidence('replacementHomeCost', windfall.replacementHomeCost),
      `purchaseClosingCostPercent=${windfall.purchaseClosingCostPercent ?? 'missing'}`,
      moneyEvidence('movingCost', windfall.movingCost),
    ],
  };
}

function buildWindfallEvent(
  windfall: WindfallEntry,
  deploymentPolicy: WindfallDeploymentPolicy | undefined,
): LifeModelAuditEvent {
  const policy = defaultedWindfallDeploymentPolicy(deploymentPolicy);
  const policyIsExplicit = Boolean(deploymentPolicy?.assumptionSource);
  const isHomeSale = windfall.taxTreatment === 'primary_home_sale' || windfall.name === 'home_sale';
  const destinationStatus: LifeModelAuditStatus = policyIsExplicit ? 'explicit' : 'inferred';

  return buildEvent({
    id: `cash_in_${windfall.name}`,
    kind: isHomeSale ? 'home_sale' : 'windfall',
    title: isHomeSale ? 'Home sale proceeds' : `Cash-in event: ${windfall.name}`,
    year: windfall.year,
    amountTodayDollars: windfall.liquidityAmount ?? windfall.amount,
    materiality: windfall.amount >= 100_000 || isHomeSale ? 'high' : 'medium',
    reviewerQuestion:
      'Does this cash-in have an explicit source, timing, tax treatment, spend/use rule, destination account, and future investment policy?',
    steps: [
      {
        id: 'source',
        status: windfall.name && windfall.amount > 0 ? 'explicit' : 'missing',
        detail: `Cash-in source is modeled as ${windfall.name}.`,
        evidence: [`name=${windfall.name}`, moneyEvidence('amount', windfall.amount)],
      },
      windfallTimingStep(windfall),
      windfallLiquidityStep(windfall),
      taxTreatmentStep(windfall),
      {
        id: 'destination',
        status: destinationStatus,
        detail: policy.enabled
          ? `Unspent cash-in is swept to a ${policy.destinationAccount} shadow investment sleeve.`
          : 'Cash-in deployment is disabled; proceeds remain in cash unless spent.',
        evidence: [
          `windfallDeploymentPolicy.enabled=${policy.enabled}`,
          `destinationAccount=${policy.destinationAccount}`,
          `trackingMode=${policy.trackingMode}`,
          `assumptionSource=${policy.assumptionSource ?? 'inferred_engine_default'}`,
        ],
      },
      {
        id: 'spending_use',
        status: destinationStatus,
        detail: policy.spendBeforeDeploy
          ? 'Same-year spending can use the received cash before any remainder is deployed.'
          : 'Cash-in is deployed before being treated as a same-year spending source.',
        evidence: [`spendBeforeDeploy=${policy.spendBeforeDeploy}`],
      },
      {
        id: 'investment_policy',
        status: destinationStatus,
        detail:
          policy.investmentPolicy === 'current_portfolio_mix'
            ? 'Remainder is invested in the shadow sleeve using the aggregate current portfolio mix.'
            : 'Remainder is invested using the taxable account target allocation.',
        evidence: [
          `investmentPolicy=${policy.investmentPolicy}`,
          `cashReserveMonths=${policy.cashReserveMonths}`,
        ],
      },
      {
        id: 'future_return_treatment',
        status: destinationStatus,
        detail:
          'After deployment, the sleeve appreciates with market returns and remains available through normal taxable withdrawals.',
        evidence: [`futureReturns=${policy.enabled ? 'taxable_market_returns' : 'cash_returns'}`],
      },
    ],
  });
}

export function buildLifeModelAudit(input: BuildLifeModelAuditInput): LifeModelAudit {
  const annualCoreSpend =
    input.data.spending.essentialMonthly * 12 +
    input.data.spending.optionalMonthly * 12 +
    input.data.spending.annualTaxesInsurance;
  const annualWithTravel = annualCoreSpend + input.data.spending.travelEarlyRetirementAnnual;
  const deploymentPolicy = input.data.rules.windfallDeploymentPolicy;
  const events: LifeModelAuditEvent[] = [
    buildEvent({
      id: 'salary_cashflow',
      kind: 'salary',
      title: 'Salary until retirement transition',
      year: validDate(input.data.income.salaryEndDate)
        ? new Date(input.data.income.salaryEndDate).getFullYear()
        : null,
      amountTodayDollars: input.data.income.salaryAnnual,
      materiality: 'high',
      reviewerQuestion:
        'Does wage income stop in the right year and flow through tax, spending, and contribution logic?',
      steps: [
        {
          id: 'source',
          status: input.data.income.salaryAnnual > 0 ? 'explicit' : 'missing',
          detail: 'Wage income is modeled from salaryAnnual until salaryEndDate.',
          evidence: [
            moneyEvidence('salaryAnnual', input.data.income.salaryAnnual),
            `salaryEndDate=${input.data.income.salaryEndDate}`,
          ],
        },
        {
          id: 'timing',
          status: validDate(input.data.income.salaryEndDate) ? 'explicit' : 'missing',
          detail: 'Salary end date controls the retirement transition year.',
          evidence: [`salaryEndDate=${input.data.income.salaryEndDate}`],
        },
        {
          id: 'tax_treatment',
          status: 'explicit',
          detail: 'Salary is taxed as ordinary wage income and payroll contributions are modeled separately.',
          evidence: [
            `payrollProrationRule=${input.data.rules.payrollModel?.salaryProrationRule ?? 'missing'}`,
            `employee401kPreTaxPercent=${input.data.income.preRetirementContributions?.employee401kPreTaxPercentOfSalary ?? 'missing'}`,
          ],
        },
        {
          id: 'destination',
          status: 'explicit',
          detail: 'Wages fund annual cashflow first, with configured pre-retirement contributions directed into retirement accounts.',
          evidence: [
            `withdrawalStyle=${input.data.rules.withdrawalStyle}`,
            `hsaPercent=${input.data.income.preRetirementContributions?.hsaPercentOfSalary ?? 'missing'}`,
          ],
        },
      ],
    }),
    buildEvent({
      id: 'social_security_cashflow',
      kind: 'social_security',
      title: 'Social Security benefit stream',
      year: null,
      amountTodayDollars: input.data.income.socialSecurity.reduce(
        (sum, entry) => sum + entry.fraMonthly * 12,
        0,
      ),
      materiality: 'high',
      reviewerQuestion:
        'Are claim ages, benefit amounts, survivor/spousal behavior, and tax treatment explicit enough for the household story?',
      steps: [
        {
          id: 'source',
          status: input.data.income.socialSecurity.length > 0 ? 'explicit' : 'missing',
          detail: 'Social Security benefit records are included for the household.',
          evidence: input.data.income.socialSecurity.map(
            (entry) => `${entry.person}:fraMonthly=${entry.fraMonthly}:claimAge=${entry.claimAge ?? 'optimizer_or_fra_default'}`,
          ),
        },
        {
          id: 'timing',
          status: input.data.income.socialSecurity.every((entry) => isFiniteNumber(entry.claimAge))
            ? 'explicit'
            : 'inferred',
          detail:
            'Claim ages are either explicit in the seed or supplied by the optimizer before projection.',
          evidence: input.data.income.socialSecurity.map(
            (entry) => `${entry.person}:claimAge=${entry.claimAge ?? 'missing'}`,
          ),
        },
        {
          id: 'tax_treatment',
          status: 'explicit',
          detail: 'Federal provisional-income Social Security taxation is modeled in the tax engine.',
          evidence: [`filingStatus=${input.data.household.filingStatus}`],
        },
        {
          id: 'destination',
          status: 'explicit',
          detail: 'Benefits enter annual cashflow before portfolio withdrawals are calculated.',
          evidence: ['destination=annual_cashflow'],
        },
      ],
    }),
    ...input.data.income.windfalls.map((windfall) =>
      buildWindfallEvent(windfall, deploymentPolicy),
    ),
    buildEvent({
      id: 'household_spending',
      kind: 'spending',
      title: 'Household spending path',
      year: null,
      amountTodayDollars: annualWithTravel,
      materiality: 'high',
      reviewerQuestion:
        'Does the modeled monthly spend include the categories the household expects monthly to mean?',
      steps: [
        {
          id: 'amount',
          status: annualCoreSpend > 0 ? 'explicit' : 'missing',
          detail: 'Core household spend is modeled from essential, optional, and taxes/insurance fields.',
          evidence: [
            moneyEvidence('essentialAnnual', input.data.spending.essentialMonthly * 12),
            moneyEvidence('optionalAnnual', input.data.spending.optionalMonthly * 12),
            moneyEvidence('annualTaxesInsurance', input.data.spending.annualTaxesInsurance),
          ],
        },
        {
          id: 'spending_use',
          status: 'explicit',
          detail: 'Travel is modeled as a separate early-retirement annual amount.',
          evidence: [
            moneyEvidence('travelEarlyRetirementAnnual', input.data.spending.travelEarlyRetirementAnnual),
            `travelPhaseYears=${input.assumptions.travelPhaseYears}`,
          ],
        },
      ],
    }),
    buildEvent({
      id: 'portfolio_withdrawals',
      kind: 'withdrawal',
      title: 'Portfolio withdrawal sourcing',
      year: null,
      amountTodayDollars: null,
      materiality: 'high',
      reviewerQuestion:
        'Are annual spending deficits sourced from the intended accounts and tax-aware withdrawal rule?',
      steps: [
        {
          id: 'source',
          status: input.assumptions.withdrawalRule || input.data.rules.withdrawalStyle
            ? 'explicit'
            : 'missing',
          detail: 'Withdrawal rule decides how cash, taxable, pretax, and Roth are used.',
          evidence: [
            `withdrawalRule=${input.assumptions.withdrawalRule ?? 'engine_default'}`,
            `withdrawalStyle=${input.data.rules.withdrawalStyle}`,
          ],
        },
        {
          id: 'tax_treatment',
          status: 'explicit',
          detail: 'Pretax withdrawals, taxable withdrawals, Roth withdrawals, RMDs, and Roth conversions feed tax calculations separately.',
          evidence: [`irmaaAware=${input.data.rules.irmaaAware}`],
        },
      ],
    }),
    buildEvent({
      id: 'healthcare_and_tax_costs',
      kind: 'healthcare',
      title: 'Healthcare, tax, IRMAA, and LTC costs',
      year: null,
      amountTodayDollars: null,
      materiality: 'high',
      reviewerQuestion:
        'Are healthcare premiums, medical inflation, LTC assumptions, taxes, ACA, and IRMAA represented as cash outflows instead of narrative caveats?',
      steps: [
        {
          id: 'amount',
          status: input.data.rules.healthcarePremiums ? 'explicit' : 'inferred',
          detail: input.data.rules.healthcarePremiums
            ? 'Healthcare premiums and medical inflation are configured in rules.'
            : 'Healthcare premium defaults are used because no explicit healthcare rule is present.',
          evidence: [
            moneyEvidence(
              'baselineAcaPremiumAnnual',
              input.data.rules.healthcarePremiums?.baselineAcaPremiumAnnual,
            ),
            moneyEvidence(
              'baselineMedicarePremiumAnnual',
              input.data.rules.healthcarePremiums?.baselineMedicarePremiumAnnual,
            ),
            `medicalInflationAnnual=${input.data.rules.healthcarePremiums?.medicalInflationAnnual ?? 'default'}`,
          ],
        },
        {
          id: 'tax_treatment',
          status: 'explicit',
          detail: 'Federal tax, ACA subsidy exposure, and IRMAA are modeled from yearly MAGI/tax inputs.',
          evidence: [
            `irmaaThreshold=${input.assumptions.irmaaThreshold}`,
            `irmaaAware=${input.data.rules.irmaaAware}`,
          ],
        },
        {
          id: 'spending_use',
          status: input.data.rules.ltcAssumptions?.enabled ? 'explicit' : 'inferred',
          detail: input.data.rules.ltcAssumptions?.enabled
            ? 'Long-term-care stress cost is explicit and can be offset by HSA strategy.'
            : 'No enabled long-term-care cost rule is present.',
          evidence: [
            `ltcEnabled=${input.data.rules.ltcAssumptions?.enabled ?? false}`,
            `hsaStrategy=${input.data.rules.hsaStrategy?.withdrawalMode ?? 'missing'}`,
          ],
        },
      ],
    }),
    ...(input.data.scheduledOutflows ?? []).map((outflow) =>
      buildEvent({
        id: `scheduled_outflow_${outflow.name}`,
        kind: 'scheduled_outflow',
        title: `Scheduled outflow: ${outflow.label}`,
        year: outflow.year,
        amountTodayDollars: outflow.amount,
        materiality: outflow.amount >= 50_000 ? 'medium' : 'low',
        reviewerQuestion:
          'Does this planned outflow have source account, recipient, tax treatment, and timing explicit?',
        steps: [
          {
            id: 'source',
            status: outflow.sourceAccount ? 'explicit' : 'missing',
            detail: `Outflow is funded from ${outflow.sourceAccount}.`,
            evidence: [`sourceAccount=${outflow.sourceAccount}`],
          },
          {
            id: 'timing',
            status: isFiniteNumber(outflow.year) ? 'explicit' : 'missing',
            detail: 'Outflow year is modeled.',
            evidence: [`year=${outflow.year}`],
          },
          {
            id: 'amount',
            status: outflow.amount > 0 ? 'explicit' : 'missing',
            detail: 'Outflow amount is modeled.',
            evidence: [moneyEvidence('amount', outflow.amount)],
          },
          {
            id: 'tax_treatment',
            status: outflow.taxTreatment ? 'explicit' : 'missing',
            detail: `Outflow tax treatment is ${outflow.taxTreatment}.`,
            evidence: [`taxTreatment=${outflow.taxTreatment}`],
          },
          {
            id: 'destination',
            status: outflow.recipient ? 'explicit' : 'missing',
            detail: `Outflow recipient is ${outflow.recipient}.`,
            evidence: [`recipient=${outflow.recipient}`, `vehicle=${outflow.vehicle}`],
          },
        ],
      }),
    ),
  ];
  const unresolved = events.filter((event) => event.reviewStatus !== 'pass');
  const materialUnresolved = unresolved.filter(
    (event) => event.materiality === 'high' || event.materiality === 'medium',
  );

  return {
    version: 'life_model_audit_v1',
    generatedAtIso: input.generatedAtIso,
    modelCompleteness: unresolved.length ? 'reconstructed' : 'faithful',
    unresolvedEventCount: unresolved.length,
    materialUnresolvedEventCount: materialUnresolved.length,
    events,
    reviewerChecklist: [
      'Trace each major inflow from source to destination account.',
      'Confirm whether each cash-in is spent, held as cash, invested, or earmarked.',
      'Confirm tax treatment before accepting monthly-spend recommendations.',
      'Flag internally consistent assumptions that do not match the household story.',
      'Separate model facts, household decisions, and AI suggestions.',
    ],
  };
}
