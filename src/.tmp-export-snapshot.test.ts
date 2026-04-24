import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { initialSeedData } from './data';
import { buildPlanningStateExportWithResolvedContext } from './planning-export';
import type { MarketAssumptions, SeedData } from './types';

const EXPORT_ASSUMPTIONS: MarketAssumptions = {
  equityMean: 0.074,
  equityVolatility: 0.16,
  internationalEquityMean: 0.074,
  internationalEquityVolatility: 0.18,
  bondMean: 0.038,
  bondVolatility: 0.07,
  cashMean: 0.02,
  cashVolatility: 0.01,
  inflation: 0.028,
  inflationVolatility: 0.01,
  simulationRuns: 500,
  irmaaThreshold: 200000,
  guardrailFloorYears: 12,
  guardrailCeilingYears: 18,
  guardrailCutPercent: 0.2,
  robPlanningEndAge: 90,
  debbiePlanningEndAge: 95,
  travelPhaseYears: 10,
  simulationSeed: 20260416,
  assumptionsVersion: 'iteration-export',
};

function cloneSeedData(data: SeedData) {
  return JSON.parse(JSON.stringify(data)) as SeedData;
}

describe('tmp export snapshot', () => {
  it('writes planning export JSON snapshot', async () => {
    const label = process.env.EXPORT_LABEL ?? 'latest';
    const outDir = resolve(process.cwd(), 'docs/exports');
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `${label}.json`);

    const payload = await buildPlanningStateExportWithResolvedContext({
      data: cloneSeedData(initialSeedData),
      assumptions: { ...EXPORT_ASSUMPTIONS },
      selectedStressorIds: [],
      selectedResponseIds: [],
    });

    writeFileSync(outPath, JSON.stringify(payload, null, 2));
    // eslint-disable-next-line no-console
    console.log(`EXPORT_WRITTEN ${outPath}`);
  }, 120_000);
});
