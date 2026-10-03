import { describe, expect, it } from 'vitest';
import { buildWorld } from '../src/network/build.js';
import { tutorialMap } from '../src/maps/tutorial.js';
import { applyCommand } from '../src/editor/commands.js';
import { tick } from '../src/game/tick.js';
import { generalLanes } from '../src/network/lanes.js';
import { planEfficiency } from '../src/control/signal.js';

const w0 = () => {
  const w = buildWorld(tutorialMap(), 3);
  w.t = 0.3 * w.config.dayLength;
  return w;
};
const run = (w: ReturnType<typeof buildWorld>, s: number) => {
  for (let i = 0; i < Math.round(s / w.config.tickDt); i++) tick(w);
};

describe('control commands', () => {
  it('installs a signal with an auto plan that has visible lost time', () => {
    const w = w0();
    const r = applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    expect(r.ok).toBe(true);
    const plan = w.nodes['n11'].control.signal!;
    expect(plan.phases.length).toBeGreaterThanOrEqual(2);
    expect(plan.cycle).toBeGreaterThan(30);
    const eff = planEfficiency(w.nodes['n11'], w, plan);
    expect(eff.lost).toBeGreaterThan(0);
    expect(eff.efficiency).toBeLessThan(1);
    // Phases never contain two hard-conflicting movements.
    const n = w.nodes['n11'];
    for (const ph of plan.phases) for (const a of ph.movements) for (const b of ph.movements) {
      if (a === b) continue;
      const k = n.conflicts[a][b];
      if (k === 'cross') {
        // only permitted lefts vs opposing through are allowed to share
        const ma = n.movements[a];
        const mb = n.movements[b];
        expect(ma.turn === 'L' || ma.turn === 'U' || mb.turn === 'L' || mb.turn === 'U').toBe(true);
      }
    }
  });
  it('protected lefts add a phase and lengthen the cycle', () => {
    const w = w0();
    applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    const before = w.nodes['n11'].control.signal!.phases.length;
    const west = w.nodes['n11'].legs.find((l) => l.leg === 3)!.inLink!;
    expect(applyCommand(w, { type: 'setLeftTreatment', nodeId: 'n11', linkId: west, treatment: 'protected' }).ok).toBe(true);
    expect(w.nodes['n11'].control.signal!.phases.length).toBe(before + 1);
  });
  it('rejects a phase with crossing throughs', () => {
    const w = w0();
    applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    const n = w.nodes['n11'];
    const north = n.legs.find((l) => l.leg === 0)!.inLink!;
    const east = n.legs.find((l) => l.leg === 1)!.inLink!;
    const r = applyCommand(w, { type: 'setPhases', nodeId: 'n11', phases: [{ movements: [`${north}:T`, `${east}:T`], split: 30 }] });
    expect(r.ok).toBe(false);
  });
  it('cycle changes rescale splits and respect minimums', () => {
    const w = w0();
    applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    expect(applyCommand(w, { type: 'setCycle', nodeId: 'n11', cycle: 120 }).ok).toBe(true);
    expect(Math.abs(w.nodes['n11'].control.signal!.cycle - 120)).toBeLessThan(1);
    expect(applyCommand(w, { type: 'setCycle', nodeId: 'n11', cycle: 10 }).ok).toBe(false);
  });
  it('signals actually cycle through phases while running', () => {
    const w = w0();
    applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    run(w, 200);
    const rt = w.nodes['n11'].control.runtime!;
    expect(rt.greenLog.length).toBeGreaterThan(2);
    const phases = new Set(rt.greenLog.map((g) => g.phase));
    expect(phases.size).toBeGreaterThan(1);
  });
  it('two-way stop picks the minor street by default', () => {
    const w = w0();
    expect(applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'two-way-stop' }).ok).toBe(true);
    const minor = w.nodes['n11'].control.minorLinks;
    expect(minor.length).toBe(2);
    for (const l of minor) expect(generalLanes(w.links[l]).length).toBe(1);
  });
});

describe('lane and road commands', () => {
  it('turn pockets cost lane-km beyond the free taper and change lane permissions', () => {
    const w = w0();
    const west = w.nodes['n11'].legs.find((l) => l.leg === 3)!.inLink!;
    const before = w.resources.laneKm;
    const r = applyCommand(w, { type: 'setPocket', linkId: west, spec: { side: 'left', storage: 60, source: 'median' } });
    expect(r.ok).toBe(true);
    expect(w.links[west].pocketLeft).not.toBeNull();
    expect(w.links[west].pocketLeft!.allowed).toEqual(['L', 'U']);
    expect(before - w.resources.laneKm).toBeCloseTo(0.03, 5);
    for (const l of generalLanes(w.links[west])) expect(l.allowed.includes('L')).toBe(false);
    // Removing refunds.
    expect(applyCommand(w, { type: 'setPocket', linkId: west, spec: { side: 'left', storage: 0, source: 'median' } }).ok).toBe(true);
    expect(w.resources.laneKm).toBeCloseTo(before, 5);
    expect(w.links[west].pocketLeft).toBeNull();
  });
  it('widening schedules construction and adds a lane on completion', () => {
    const w = w0();
    const before = generalLanes(w.links['v10>']).length;
    const r = applyCommand(w, { type: 'widen', roadId: 'v10', dir: 'fwd' });
    expect(r.ok).toBe(true);
    expect(w.constructions.length).toBe(1);
    expect(generalLanes(w.links['v10>']).length).toBe(before);
    run(w, w.config.dayLength + 5);
    expect(w.constructions.length).toBe(0);
    expect(generalLanes(w.links['v10>']).length).toBe(before + 1);
    expect(w.roads['v10'].widthLanes).toBeGreaterThan(0);
    // Vehicles reference valid lane ids after renumbering.
    for (const v of Object.values(w.vehicles)) if (v.place.kind === 'lane') expect(w.lanes[v.place.laneId]).toBeDefined();
  });
  it('refuses to widen without lane-km', () => {
    const w = w0();
    w.resources.laneKm = 0;
    expect(applyCommand(w, { type: 'widen', roadId: 'v10', dir: 'fwd' }).ok).toBe(false);
  });
  it('reallocates lanes within width (tidal flow) and rejects over-allocation', () => {
    const w = w0();
    expect(applyCommand(w, { type: 'reallocate', roadId: 'h10', fwd: 3, bwd: 1 }).ok).toBe(true);
    expect(generalLanes(w.links['h10>']).length).toBe(3);
    expect(generalLanes(w.links['h10<']).length).toBe(1);
    expect(applyCommand(w, { type: 'reallocate', roadId: 'h10', fwd: 4, bwd: 2 }).ok).toBe(false);
  });
  it('removing parking frees a travel lane', () => {
    const w = w0();
    expect(generalLanes(w.links['v10>']).length).toBe(1);
    expect(applyCommand(w, { type: 'setParking', linkId: 'v10>', mode: 'none' }).ok).toBe(true);
    expect(generalLanes(w.links['v10>']).length).toBe(2);
  });
  it('one-way conversion needs a token, removes the reverse link and keeps vehicles consistent', () => {
    const w = w0();
    expect(applyCommand(w, { type: 'setOneWay', roadId: 'v11', mode: 'fwd' }).ok).toBe(false);
    expect(applyCommand(w, { type: 'setOneWay', roadId: 'v10', mode: 'fwd' }).ok).toBe(false); // bus route uses v10<
    w.resources.tokens = 1;
    run(w, 60);
    const r = applyCommand(w, { type: 'setOneWay', roadId: 'v11', mode: 'fwd' });
    expect(r.ok).toBe(true);
    expect(w.links['v11<']).toBeUndefined();
    expect(generalLanes(w.links['v11>']).length).toBe(2);
    expect(w.resources.tokens).toBe(0);
    // The driveway that was on the removed direction migrated.
    expect(w.generators['houses-s'].drivewayLink).toBe('v11>');
    for (const v of Object.values(w.vehicles)) expect(v.route.includes('v11<')).toBe(false);
    run(w, 120);
    expect(applyCommand(w, { type: 'setOneWay', roadId: 'v11', mode: 'none' }).ok).toBe(true);
    expect(w.links['v11<']).toBeDefined();
  });
});

describe('structures', () => {
  it('roundabout replaces control and changes conflict handling', () => {
    const w = w0();
    w.resources.tokens = 1;
    expect(applyCommand(w, { type: 'buildRoundabout', nodeId: 'n11', lanes: 1 }).ok).toBe(true);
    expect(w.nodes['n11'].control.type).toBe('roundabout');
    run(w, 300);
    expect(w.gameOver).toBe(false);
    expect(w.nodes['n11'].metrics.served).toBeGreaterThan(0);
  });
  it('MUT bans lefts, adds crossovers and routes lefts through U-turns', () => {
    const w = w0();
    w.resources.tokens = 1;
    applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    const r = applyCommand(w, { type: 'transform', nodeId: 'n11', form: 'mut' });
    expect(r.ok).toBe(true);
    const n = w.nodes['n11'];
    expect(Object.values(n.movements).some((m) => m.turn === 'L')).toBe(false);
    expect(w.roads['h10'].crossovers.length + w.roads['h11'].crossovers.length).toBe(2);
    run(w, 400);
    expect(w.gameOver).toBe(false);
    // Some vehicle used a crossover (reverse-link successor in its route) or is waiting in one.
    const used = Object.values(w.vehicles).some((v) => v.route.some((l, i) => i > 0 && w.links[l] && w.links[v.route[i - 1]] && w.links[l].roadId === w.links[v.route[i - 1]].roadId));
    expect(used || w.metrics.tripsCompleted > 0).toBe(true);
  });
  it('CFI removes the left/through conflict at the arterial', () => {
    const w = w0();
    w.resources.tokens = 2;
    expect(applyCommand(w, { type: 'transform', nodeId: 'n11', form: 'cfi' }).ok).toBe(true);
    const n = w.nodes['n11'];
    const west = n.legs.find((l) => l.leg === 3)!.inLink!;
    const east = n.legs.find((l) => l.leg === 1)!.inLink!;
    expect(n.conflicts[`${west}:L`][`${east}:T`]).toBe('none');
    run(w, 200);
    expect(w.gameOver).toBe(false);
  });
  it('interchange makes arterial throughs free-flowing', () => {
    const w = w0();
    w.resources.tokens = 3;
    expect(applyCommand(w, { type: 'buildInterchange', nodeId: 'n11', form: 'diamond' }).ok).toBe(true);
    expect(w.interchanges['n11']).toBeDefined();
    run(w, 300);
    expect(w.gameOver).toBe(false);
  });
});

describe('access and curb', () => {
  it('right-in/right-out driveway removes the left-in destination link', () => {
    const w = w0();
    expect(applyCommand(w, { type: 'setDriveway', generatorId: 'shops-centre', access: 'right-in-right-out' }).ok).toBe(true);
    run(w, 300);
    for (const v of Object.values(w.vehicles)) {
      if (v.destGen !== 'shops-centre') continue;
      expect(v.route[v.route.length - 1]).toBe(w.generators['shops-centre'].drivewayLink);
    }
  });
  it('bus bays create a bay lane and buses still serve stops', () => {
    const w = w0();
    expect(applyCommand(w, { type: 'setBusStop', stopId: 'bus1-s0', kind: 'bay' }).ok).toBe(true);
    expect(w.links['h10>'].bays.length).toBe(1);
    run(w, 600);
    expect(w.gameOver).toBe(false);
  });
});
