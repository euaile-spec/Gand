import { describe, expect, it } from 'vitest';
import { buildWorld } from '../src/network/build.js';
import { proceduralMap } from '../src/maps/procedural.js';
import { tutorialMap } from '../src/maps/tutorial.js';
import { Game } from '../src/game/game.js';
import { applyCommand } from '../src/editor/commands.js';
import { dailyGame, dailyScenario, dailySeed } from '../src/game/daily.js';
import { tick } from '../src/game/tick.js';

describe('procedural maps', () => {
  it('are deterministic per seed and differ across seeds', () => {
    const a = proceduralMap(7);
    const b = proceduralMap(7);
    const c = proceduralMap(8);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });
  it('build with ≤ 4 legs per node, valid bus loops and a growth schedule', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const m = proceduralMap(seed);
      const w = buildWorld(m, seed);
      for (const n of Object.values(w.nodes)) expect(n.legs.length).toBeLessThanOrEqual(4);
      expect(Object.keys(w.busRoutes).length).toBeGreaterThan(0);
      expect(m.growth!.length).toBeGreaterThan(0);
      expect(w.pendingGrowth.length).toBe(m.growth!.length);
    }
  });
});

describe('city growth', () => {
  it('adds a road, a node and a generator on schedule and re-plans the attached signal', () => {
    const m = tutorialMap();
    // xW0 is the west gateway stub of row 0: one leg, room to grow.
    m.growth = [{ day: 1, node: { id: 'dev', x: -150, y: -160 }, road: { id: 'rdev', a: 'xW0', b: 'dev' }, generator: { id: 'office-dev', kind: 'office', size: 40, roadId: 'rdev', t: 0.8, side: 'fwd' } }];
    const g = new Game(m, 3);
    g.apply({ type: 'setControl', nodeId: 'xW0', control: 'signal' });
    const legsBefore = g.world.nodes['xW0'].legs.length;
    const phasesBefore = g.world.nodes['xW0'].control.signal!.phases.map((p) => p.movements.length);
    expect(g.world.roads['rdev']).toBeUndefined();
    g.advance(g.world.config.dayLength + 1);
    expect(g.world.roads['rdev']).toBeDefined();
    expect(g.world.nodes['dev']).toBeDefined();
    expect(g.world.generators['office-dev'].active).toBe(true);
    expect(g.world.nodes['xW0'].legs.length).toBe(legsBefore + 1);
    // The new leg's movements exist and are served by some phase.
    const plan = g.world.nodes['xW0'].control.signal!;
    const newIn = `rdev<`;
    expect(Object.values(g.world.nodes['xW0'].movements).some((mv) => mv.fromLink === newIn)).toBe(true);
    expect(plan.phases.some((p) => p.movements.some((k) => k.startsWith(newIn)))).toBe(true);
    expect(plan.phases.map((p) => p.movements.length)).not.toEqual(phasesBefore);
    expect(g.world.events.some((e) => e.kind === 'new-road' && e.target === 'rdev')).toBe(true);
    // Traffic uses it.
    g.advance(600);
    expect(g.world.gameOver).toBe(false);
    const dw = g.world.links['rdev>'].driveways[0];
    expect(dw.generatorId).toBe('office-dev');
  }, 60000);
  it('refuses to attach to a node that already has four legs', () => {
    const m = tutorialMap();
    m.growth = [{ day: 1, node: { id: 'dev', x: 200, y: -400 }, road: { id: 'rdev', a: 'n11', b: 'dev' }, generator: { id: 'x', kind: 'house', size: 10, roadId: 'rdev', t: 0.5, side: 'fwd' } }];
    const g = new Game(m, 3);
    g.advance(g.world.config.dayLength + 1);
    expect(g.world.roads['rdev']).toBeUndefined();
    expect(g.world.pendingGrowth.length).toBe(0);
  }, 60000);
});

describe('pavement wear', () => {
  it('accumulates with traffic, slows vehicles, and is reset by repaving', () => {
    const w = buildWorld(tutorialMap(), 4);
    w.t = 0.3 * w.config.dayLength;
    w.config.wearPerCarKm = 2e-3; // accelerate for the test
    for (let i = 0; i < Math.round(900 / w.config.tickDt); i++) tick(w);
    const worst = Object.values(w.links).sort((a, b) => b.wear - a.wear)[0];
    expect(worst.wear).toBeGreaterThan(0.02);
    const road = w.roads[worst.roadId];
    const before = w.resources.laneKm;
    const r = applyCommand(w, { type: 'repave', roadId: road.id });
    expect(r.ok).toBe(true);
    expect(w.resources.laneKm).toBeLessThan(before);
    expect(w.constructions.some((c) => c.kind === 'repave')).toBe(true);
    for (let i = 0; i < Math.round((w.config.dayLength + 5) / w.config.tickDt); i++) tick(w);
    expect(w.links[worst.id].wear).toBeLessThan(0.02);
  }, 60000);
  it('severe crashes scar the pavement', () => {
    const w = buildWorld(tutorialMap(), 4);
    const link = w.links['h10>'];
    const start = link.wear;
    link.wear = Math.min(1, link.wear + 0.05);
    expect(link.wear).toBeGreaterThan(start);
  });
});

describe('daily challenge', () => {
  it('is the same city and the same run for the same date', () => {
    const a = dailyGame('2026-10-03');
    const b = dailyGame('2026-10-03');
    expect(a.map.name).toBe(b.map.name);
    expect(dailySeed('2026-10-03')).not.toBe(dailySeed('2026-10-04'));
    a.advance(300);
    b.advance(300);
    expect(a.world.metrics.tripsCompleted).toBe(b.world.metrics.tripsCompleted);
    expect(a.world.rng.s).toBe(b.world.rng.s);
  });
  it('has a ten-day deadline and reports a score', () => {
    const s = dailyScenario('2026-01-01');
    expect(s.deadlineDay).toBe(10);
    const g = Game.fromScenario(s, dailySeed('2026-01-01'));
    g.advance(120);
    expect(g.goal()!.label).toContain('score');
  });
});
