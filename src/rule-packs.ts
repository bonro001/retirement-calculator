export const CURRENT_RULE_PACK_VERSION = 'current-law-2026-v1';

const ORDINARY_INF = Number.POSITIVE_INFINITY;
const IRMAA_INF = Number.POSITIVE_INFINITY;

export const CURRENT_LAW_2026_RULE_PACK = {
  version: CURRENT_RULE_PACK_VERSION,
  federalTax: {
    taxYear: 2026,
    provenance: {
      source: 'IRS Rev. Proc. 2025-32',
      url: 'https://www.irs.gov/pub/irs-drop/rp-25-32.pdf',
    },
    profiles: {
      single: {
        standardDeduction: 16_100,
        ordinaryBrackets: [
          { upTo: 12_400, rate: 0.1 },
          { upTo: 50_400, rate: 0.12 },
          { upTo: 105_700, rate: 0.22 },
          { upTo: 201_775, rate: 0.24 },
          { upTo: 256_225, rate: 0.32 },
          { upTo: 640_600, rate: 0.35 },
          { upTo: ORDINARY_INF, rate: 0.37 },
        ],
        capitalGainsThresholds: {
          zeroRateTop: 49_450,
          fifteenRateTop: 545_500,
        },
        socialSecurityThresholds: {
          firstBase: 25_000,
          secondBase: 34_000,
          secondTierAdjustmentCap: 4_500,
        },
      },
      married_filing_jointly: {
        standardDeduction: 32_200,
        ordinaryBrackets: [
          { upTo: 24_800, rate: 0.1 },
          { upTo: 100_800, rate: 0.12 },
          { upTo: 211_400, rate: 0.22 },
          { upTo: 403_550, rate: 0.24 },
          { upTo: 512_450, rate: 0.32 },
          { upTo: 768_700, rate: 0.35 },
          { upTo: ORDINARY_INF, rate: 0.37 },
        ],
        capitalGainsThresholds: {
          zeroRateTop: 98_900,
          fifteenRateTop: 613_700,
        },
        socialSecurityThresholds: {
          firstBase: 32_000,
          secondBase: 44_000,
          secondTierAdjustmentCap: 6_000,
        },
      },
      married_filing_separately: {
        standardDeduction: 16_100,
        ordinaryBrackets: [
          { upTo: 12_400, rate: 0.1 },
          { upTo: 50_400, rate: 0.12 },
          { upTo: 105_700, rate: 0.22 },
          { upTo: 201_775, rate: 0.24 },
          { upTo: 256_225, rate: 0.32 },
          { upTo: 384_350, rate: 0.35 },
          { upTo: ORDINARY_INF, rate: 0.37 },
        ],
        capitalGainsThresholds: {
          zeroRateTop: 49_450,
          fifteenRateTop: 306_850,
        },
        socialSecurityThresholds: {
          firstBase: 0,
          secondBase: 0,
          secondTierAdjustmentCap: 0,
        },
      },
      head_of_household: {
        standardDeduction: 24_150,
        ordinaryBrackets: [
          { upTo: 17_700, rate: 0.1 },
          { upTo: 67_450, rate: 0.12 },
          { upTo: 105_700, rate: 0.22 },
          { upTo: 201_750, rate: 0.24 },
          { upTo: 256_200, rate: 0.32 },
          { upTo: 640_600, rate: 0.35 },
          { upTo: ORDINARY_INF, rate: 0.37 },
        ],
        capitalGainsThresholds: {
          zeroRateTop: 66_200,
          fifteenRateTop: 579_650,
        },
        socialSecurityThresholds: {
          firstBase: 25_000,
          secondBase: 34_000,
          secondTierAdjustmentCap: 4_500,
        },
      },
    },
    additionalStandardDeductionForAge65: {
      perElderlyByStatus: {
        single: 2_050,
        head_of_household: 2_050,
        married_filing_jointly: 1_650,
        married_filing_separately: 1_650,
      },
    },
    netInvestmentIncomeTax: {
      source: 'IRC §1411 statutory thresholds',
      rate: 0.038,
      magiThresholds: {
        single: 200_000,
        head_of_household: 200_000,
        married_filing_jointly: 250_000,
        married_filing_separately: 125_000,
      },
    },
    additionalMedicareTax: {
      source: 'IRC §1401(b) statutory thresholds',
      rate: 0.009,
      wageThresholds: {
        single: 200_000,
        head_of_household: 200_000,
        married_filing_jointly: 250_000,
        married_filing_separately: 125_000,
      },
    },
  },
  contributions: {
    taxYear: 2026,
    provenance: {
      retirementPlanSource: 'IRS Notice 2025-67 / IR-2025-111',
      retirementPlanUrl:
        'https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500',
      hsaSource: 'IRS Rev. Proc. 2025-19',
      hsaUrl: 'https://www.irs.gov/irb/2025-21_IRB',
    },
    employee401kBaseLimit: 24_500,
    employee401kCatchUpAge: 50,
    employee401kCatchUpLimit: 8_000,
    employee401kSuperCatchUpAges: [60, 61, 62, 63],
    employee401kSuperCatchUpLimit: 11_250,
    rothCatchUpWageThreshold: 150_000,
    hsaSelfLimit: 4_400,
    hsaFamilyLimit: 8_750,
    hsaCatchUpAge: 55,
    hsaCatchUpLimit: 1_000,
  },
  aca: {
    planYear: 2026,
    fplYear: 2025,
    lawRegime: 'current-law-2026-restored-400-fpl-cliff',
    provenance: {
      fplSource: 'HHS 2025 Poverty Guidelines for the 48 contiguous states and DC',
      fplUrl: 'https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines',
      cliffSource: 'ACA premium tax credit law after enhanced subsidies sunset after 2025',
    },
    expectedContributionByFplBand: [
      { minFplRatio: 0, maxFplRatio: 1.33, minRate: 0.021, maxRate: 0.021 },
      { minFplRatio: 1.33, maxFplRatio: 1.5, minRate: 0.0314, maxRate: 0.0419 },
      { minFplRatio: 1.5, maxFplRatio: 2.0, minRate: 0.0419, maxRate: 0.066 },
      { minFplRatio: 2.0, maxFplRatio: 2.5, minRate: 0.066, maxRate: 0.0844 },
      { minFplRatio: 2.5, maxFplRatio: 3.0, minRate: 0.0844, maxRate: 0.0996 },
      { minFplRatio: 3.0, maxFplRatio: 4.0, minRate: 0.0996, maxRate: 0.0996 },
    ],
    subsidyEligibilityMaxFplRatio: 4.0,
    federalPovertyLevelByHouseholdSize: {
      1: 15_650,
      2: 21_150,
      3: 26_650,
      4: 32_150,
    },
    fplAdditionalPerson: 5_500,
  },
  irmaa: {
    premiumYear: 2026,
    lookbackYears: 2,
    provenance: {
      source: 'CMS 2026 Medicare Parts A & B Premiums and Deductibles fact sheet',
      url: 'https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles',
    },
    brackets: {
      single: [
        { maxMagi: 109_000, partBSurchargeMonthly: 0, partDSurchargeMonthly: 0 },
        { maxMagi: 137_000, partBSurchargeMonthly: 81.2, partDSurchargeMonthly: 14.5 },
        { maxMagi: 171_000, partBSurchargeMonthly: 202.9, partDSurchargeMonthly: 37.5 },
        { maxMagi: 205_000, partBSurchargeMonthly: 324.6, partDSurchargeMonthly: 60.4 },
        { maxMagi: 500_000, partBSurchargeMonthly: 446.3, partDSurchargeMonthly: 83.3 },
        { maxMagi: IRMAA_INF, partBSurchargeMonthly: 487.0, partDSurchargeMonthly: 91.0 },
      ],
      head_of_household: [
        { maxMagi: 109_000, partBSurchargeMonthly: 0, partDSurchargeMonthly: 0 },
        { maxMagi: 137_000, partBSurchargeMonthly: 81.2, partDSurchargeMonthly: 14.5 },
        { maxMagi: 171_000, partBSurchargeMonthly: 202.9, partDSurchargeMonthly: 37.5 },
        { maxMagi: 205_000, partBSurchargeMonthly: 324.6, partDSurchargeMonthly: 60.4 },
        { maxMagi: 500_000, partBSurchargeMonthly: 446.3, partDSurchargeMonthly: 83.3 },
        { maxMagi: IRMAA_INF, partBSurchargeMonthly: 487.0, partDSurchargeMonthly: 91.0 },
      ],
      married_filing_jointly: [
        { maxMagi: 218_000, partBSurchargeMonthly: 0, partDSurchargeMonthly: 0 },
        { maxMagi: 274_000, partBSurchargeMonthly: 81.2, partDSurchargeMonthly: 14.5 },
        { maxMagi: 342_000, partBSurchargeMonthly: 202.9, partDSurchargeMonthly: 37.5 },
        { maxMagi: 410_000, partBSurchargeMonthly: 324.6, partDSurchargeMonthly: 60.4 },
        { maxMagi: 750_000, partBSurchargeMonthly: 446.3, partDSurchargeMonthly: 83.3 },
        { maxMagi: IRMAA_INF, partBSurchargeMonthly: 487.0, partDSurchargeMonthly: 91.0 },
      ],
      married_filing_separately: [
        { maxMagi: 109_000, partBSurchargeMonthly: 0, partDSurchargeMonthly: 0 },
        { maxMagi: 391_000, partBSurchargeMonthly: 446.3, partDSurchargeMonthly: 83.3 },
        { maxMagi: IRMAA_INF, partBSurchargeMonthly: 487.0, partDSurchargeMonthly: 91.0 },
      ],
    },
  },
  rmd: {
    provenance: {
      source: 'IRS Uniform Lifetime Table effective 2022 and SECURE 2.0 RMD start ages',
      url: 'https://www.irs.gov/retirement-plans/retirement-plan-and-ira-required-minimum-distributions-faqs',
    },
    startAgesByBirthYear: {
      through1950: 72,
      from1951Through1959: 73,
      from1960: 75,
    },
  },
  socialSecurity: {
    provenance: {
      source: 'IRS Publication 915 statutory provisional-income thresholds',
      url: 'https://www.irs.gov/publications/p915',
    },
    inclusionMaxRate: 0.85,
  },
};
