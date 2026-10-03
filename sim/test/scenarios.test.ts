import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game.js';
import { SCENARIOS, TUTORIAL_CHAIN, nextInChain, scenarioById } from '../src/game/scenarios.js';

describe('tutorial chain', () => {
  it('has ten tutorials in order and a next pointer', () => {
    expect(TUTORIAL_CHAIN.length).toBe(10);
    expect(nextInChain('t01-first-signal')?.id).toBe('t02-lost-time');
    expect(nextInChain('t10-metering')).toBeNull();
  });
  it('every scenario builds, applies its setup, and reports a goal', () => {
    for (const s of SCENARIOS) {
      const g = Game.fromScenario(s, 3);
      const goal = g.goal()!;
      expect(goal).not.toBeNull();
      expect(typeof goal.label).toBe('string');
      expect(g.log.length).toBe(0); // setup is not part of the player's log
      g.advance(60);
      expect(g.world.gameOver).toBe(false);
    }
  });
  it('setups create the broken state they describe', () => {
    const lost = Game.fromScenario(scenarioById('t02-lost-time')!, 1);
    expect(lost.world.nodes['n11'].control.signal!.phases.length).toBeGreaterThanOrEqual(4);
    expect(lost.world.nodes['n11'].control.signal!.cycle).toBeGreaterThan(140);
    const pocket = Game.fromScenario(scenarioById('t03-short-pocket')!, 1);
    const east = pocket.world.nodes['n11'].legs.find((l) => l.leg === 1)!.inLink!;
    expect(pocket.world.links[east].pocketLeft!.end - pocket.world.links[east].pocketLeft!.start).toBe(20);
    const match = Game.fromScenario(scenarioById('t10-metering')!, 1);
    expect(match.world.events.some((e) => e.kind === 'stadium-letout')).toBe(true);
    expect(match.world.generators['stadium'].active).toBe(true);
  });
  it('locks tools the scenario has not unlocked', () => {
    const g = Game.fromScenario(scenarioById('t01-first-signal')!, 1);
    expect(g.apply({ type: 'setActuated', nodeId: 'n11', on: true }).ok).toBe(false);
    expect(g.apply({ type: 'setDriveway', generatorId: 'mall', access: 'right-in-right-out' }).ok).toBe(false);
    const g6 = Game.fromScenario(scenarioById('t06-driveways')!, 1);
    expect(g6.apply({ type: 'setDriveway', generatorId: 'mall', access: 'right-in-right-out' }).ok).toBe(true);
  });
  it('the first tutorial is solvable by installing a signal', () => {
    const g = Game.fromScenario(scenarioById('t01-first-signal')!, 2);
    g.apply({ type: 'setControl', nodeId: 'n11', control: 'signal' });
    g.apply({ type: 'setCycle', nodeId: 'n11', cycle: 60 });
    g.advance(g.world.config.dayLength * 0.4);
    const goal = g.goal()!;
    expect(goal.met).toBe(true);
  });
  it('the lost-time tutorial improves when the plan is simplified', () => {
    const g = Game.fromScenario(scenarioById('t02-lost-time')!, 2);
    const before = g.goal()!;
    // The fix: stop split-phasing every approach, then shorten the cycle.
    for (const leg of g.world.nodes['n11'].legs) if (leg.inLink) g.apply({ type: 'setLeftTreatment', nodeId: 'n11', linkId: leg.inLink, treatment: 'permitted' });
    g.apply({ type: 'setCycle', nodeId: 'n11', cycle: 60 });
    g.advance(g.world.config.dayLength * 0.3);
    const after = g.goal()!;
    expect(g.world.nodes['n11'].control.signal!.phases.length).toBeLessThan(4);
    expect(after.progress).toBeGreaterThanOrEqual(before.progress);
  });
});
