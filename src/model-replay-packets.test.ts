import { describe, expect, it } from 'vitest';
import {
  modelReplayPacketFixture,
  replayModelPacketFixture,
} from './model-replay-packets';

describe('model replay packets', () => {
  it('keeps replay packet assumptions explicit and faithful', () => {
    expect(modelReplayPacketFixture.$schemaVersion).toBe(1);
    expect(modelReplayPacketFixture.$meta.modelCompleteness).toBe('faithful');
    expect(modelReplayPacketFixture.$meta.inferredAssumptions).toEqual([]);
    expect(modelReplayPacketFixture.$meta.currentHouseholdPacketId).toBe(
      'current_88_91_planner_40_987654',
    );
    expect(modelReplayPacketFixture.$meta.compatibilityPacketIds).toEqual([
      'default_raw_40_987654',
      'stress_response_planner_40_987654',
    ]);
    expect(modelReplayPacketFixture.packets.length).toBeGreaterThanOrEqual(3);
    expect(
      modelReplayPacketFixture.packets.some(
        (packet) => packet.id === 'current_88_91_planner_40_987654',
      ),
    ).toBe(true);

    for (const packet of modelReplayPacketFixture.packets) {
      expect(packet.modelCompleteness).toBe('faithful');
      expect(packet.inferredAssumptions).toEqual([]);
      expect(packet.input.assumptions.simulationSeed).toBe(987654);
      expect(packet.input.assumptions.simulationRuns).toBe(40);
      expect(packet.input.data.goals?.protectedReserve).toMatchObject({
        targetTodayDollars: 1_000_000,
        purpose: 'care_first_legacy_if_unused',
        availableFor: 'late_life_care_or_health_shocks',
        normalLifestyleSpendable: false,
      });
      expect(packet.expected.yearlyLedger.length).toBeGreaterThan(20);
      expect(packet.expected.summary.successRate).toBeGreaterThanOrEqual(0);
      expect(packet.expected.summary.successRate).toBeLessThanOrEqual(1);
    }

    const currentPacket = modelReplayPacketFixture.packets.find(
      (packet) => packet.id === 'current_88_91_planner_40_987654',
    );
    expect(currentPacket?.input.assumptions.robPlanningEndAge).toBe(88);
    expect(currentPacket?.input.assumptions.debbiePlanningEndAge).toBe(91);
    expect(currentPacket?.expected.yearlyLedger).toHaveLength(30);
    expect(currentPacket?.expected.yearlyLedger.at(-1)?.year).toBe(2055);
  });

  it('replays frozen packets exactly, including compact yearly ledgers', () => {
    const results = replayModelPacketFixture();

    expect(results.map((result) => result.passed)).toEqual(
      results.map(() => true),
    );
    expect(results.flatMap((result) => result.mismatches)).toEqual([]);
  });
});
