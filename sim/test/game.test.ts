import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game.js';
import { tutorialMap } from '../src/maps/tutorial.js';
import { SCENARIOS } from '../src/game/scenarios.js';

describe('Game', () => {
  it('is deterministic for a given seed and command log', () => {
    const a = new Game(tutorialMap(), 11);
    const b = new Game(tutorialMap(), 11);
    a.advance(120);
    b.advance(120);
    a.apply({ type: 'setControl', nodeId: 'n11', control: 'signal' });
    b.apply({ type: 'setControl', nodeId: 'n11', control: 'signal' });
    a.advance(300);
    b.advance(300);
    expect(a.world.metrics.tripsCompleted).toBe(b.world.metrics.tripsCompleted);
    expect(a.world.rng.s).toBe(b.world.rng.s);
    expect(Object.keys(a.world.vehicles)).toEqual(Object.keys(b.world.vehicles));
  });
  it('save/load replays to the same state', () => {
    const g = new Game(tutorialMap(), 5);
    g.advance(100);
    g.apply({ type: 'setControl', nodeId: 'n11', control: 'signal' });
    g.advance(200);
    g.apply({ type: 'setParking', linkId: 'v10>', mode: 'none' });
    g.advance(100);
    const save = g.save();
    const g2 = Game.load(save, null, g.world.t);
    expect(g2.world.t).toBeCloseTo(g.world.t, 3);
    expect(g2.world.metrics.tripsCompleted).toBe(g.world.metrics.tripsCompleted);
    expect(g2.world.rng.s).toBe(g.world.rng.s);
  });
  it('draft mode stages commands, previews them, and commits', () => {
    const g = new Game(tutorialMap(), 9);
    g.advance(300);
    g.beginDraft();
    expect(g.apply({ type: 'setControl', nodeId: 'n11', control: 'signal' }).ok).toBe(true);
    expect(g.apply({ type: 'setCycle', nodeId: 'n11', cycle: 10 }).ok).toBe(false);
    expect(g.world.nodes['n11'].control.type).toBe('uncontrolled');
    const p = g.preview(undefined, 120);
    expect(p.errors).toEqual([]);
    expect(p.before.vehicles).toBeGreaterThanOrEqual(0);
    expect(g.world.nodes['n11'].control.type).toBe('uncontrolled'); // preview did not touch the live world
    const results = g.commitDraft();
    expect(results.every((r) => r.ok)).toBe(true);
    expect(g.world.nodes['n11'].control.type).toBe('signal');
    expect(g.draft).toBeNull();
  });
  it('speed control and pause', () => {
    const g = new Game(tutorialMap(), 2);
    g.speed = 0;
    g.step(10);
    const t0 = g.world.t;
    expect(g.world.t).toBe(t0);
    g.speed = 4;
    g.step(1);
    expect(g.world.t - t0).toBeGreaterThan(3.8);
    expect(g.world.t - t0).toBeLessThanOrEqual(4.01);
  });
  it('scenarios report goals and lock tools', () => {
    const g = Game.fromScenario(SCENARIOS[0], 1);
    expect(g.goal()).not.toBeNull();
    // Roundabouts are not unlocked in scenario 1.
    g.world.resources.tokens = 1;
    expect(g.apply({ type: 'buildRoundabout', nodeId: 'n11', lanes: 1 }).ok).toBe(false);
    expect(g.apply({ type: 'setControl', nodeId: 'n11', control: 'signal' }).ok).toBe(true);
  });
  it('weeks grant lane-km and a pending choice', () => {
    const g = new Game(tutorialMap(), 4, null, { dayLength: 120 });
    const before = g.world.resources.laneKm;
    g.advance(120 * 7 + 1);
    expect(g.world.week).toBe(1);
    expect(g.world.resources.laneKm).toBeGreaterThan(before);
    expect(g.world.resources.pendingWeeklyChoice).toBe(true);
    expect(g.apply({ type: 'weeklyChoice', choice: 'token' }).ok).toBe(true);
    expect(g.world.resources.tokens).toBe(1);
  });
});
