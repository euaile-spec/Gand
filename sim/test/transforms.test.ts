import { describe, expect, it } from 'vitest';
import { buildWorld } from '../src/network/build.js';
import { tutorialMap } from '../src/maps/tutorial.js';
import { applyCommand } from '../src/editor/commands.js';
import { tick } from '../src/game/tick.js';
import { generalLanes } from '../src/network/lanes.js';
import { cfiCrossingOpen } from '../src/control/manager.js';

const w0 = () => {
  const w = buildWorld(tutorialMap(), 8);
  w.t = 0.3 * w.config.dayLength;
  return w;
};
const run = (w: ReturnType<typeof buildWorld>, s: number) => {
  for (let i = 0; i < Math.round(s / w.config.tickDt); i++) tick(w);
};
const inLink = (w: ReturnType<typeof buildWorld>, node: string, leg: number) => w.nodes[node].legs.find((l) => l.leg === leg)!.inLink!;

describe('CFI with physical displaced-left bays', () => {
  it('builds a bay per arterial approach gated by a pre-signal tied to the main signal', () => {
    const w = w0();
    w.resources.tokens = 2;
    expect(applyCommand(w, { type: 'transform', nodeId: 'n11', form: 'cfi' }).ok).toBe(true);
    const west = inLink(w, 'n11', 3);
    const east = inLink(w, 'n11', 1);
    for (const id of [west, east]) {
      const link = w.links[id];
      expect(link.pocketLeft?.cfi).toBe(true);
      expect(link.pocketLeft!.end - link.pocketLeft!.start).toBeGreaterThanOrEqual(80);
      for (const l of generalLanes(link)) expect(l.allowed.includes('L')).toBe(false);
    }
    expect(w.roads['h10'].crossovers.some((x) => x.kind === 'cfi-presignal' && x.mainNode === 'n11')).toBe(true);
    // The crossing is closed while the arterial throughs have green, open during the cross-street phase.
    const n = w.nodes['n11'];
    const plan = n.control.signal!;
    const rt = n.control.runtime!;
    const artIdx = plan.phases.findIndex((p) => p.movements.includes(`${west}:T`));
    const minorIdx = plan.phases.findIndex((p) => !p.movements.includes(`${west}:T`) && !p.movements.includes(`${east}:T`));
    rt.phaseIdx = artIdx;
    rt.state = 'green';
    rt.greenStart = w.t;
    expect(cfiCrossingOpen(w, west)).toBe(false);
    rt.phaseIdx = minorIdx;
    expect(cfiCrossingOpen(w, west)).toBe(true);
  });
  it('lefts flow through the bay and nothing gridlocks', () => {
    const w = w0();
    w.resources.tokens = 2;
    applyCommand(w, { type: 'transform', nodeId: 'n11', form: 'cfi' });
    run(w, 600);
    const n = w.nodes['n11'];
    const west = inLink(w, 'n11', 3);
    const east = inLink(w, 'n11', 1);
    const lefts = (n.metrics.tmcWindow[`${west}:L`] ?? 0) + (n.metrics.tmcWindow[`${east}:L`] ?? 0) + (n.metrics.tmcLast[`${west}:L`] ?? 0) + (n.metrics.tmcLast[`${east}:L`] ?? 0);
    expect(lefts).toBeGreaterThan(0);
    expect(w.gameOver).toBe(false);
  });
  it('removing the CFI tears down bays and crossovers', () => {
    const w = w0();
    w.resources.tokens = 2;
    applyCommand(w, { type: 'transform', nodeId: 'n11', form: 'cfi' });
    expect(applyCommand(w, { type: 'transform', nodeId: 'n11', form: 'none' }).ok).toBe(true);
    const west = inLink(w, 'n11', 3);
    expect(w.links[west].pocketLeft).toBeNull();
    expect(w.roads['h10'].crossovers.length).toBe(0);
    expect(w.resources.tokens).toBe(2);
  });
});

describe('interchange with ramps', () => {
  it('builds off-ramp pockets carrying every exit and on-ramp merge lanes', () => {
    const w = w0();
    w.resources.tokens = 3;
    expect(applyCommand(w, { type: 'buildInterchange', nodeId: 'n11', form: 'diamond' }).ok).toBe(true);
    const west = inLink(w, 'n11', 3);
    const link = w.links[west];
    expect(link.pocketRight?.ramp).toBe(true);
    expect(link.pocketRight!.allowed.sort()).toEqual(['L', 'R', 'U']);
    for (const l of generalLanes(link)) expect(l.allowed).toEqual(['T']);
    const out = w.nodes['n11'].legs.find((l) => l.leg === 1)!.outLink!;
    const ramp = w.links[out].lanes.find((l) => l.ramp);
    expect(ramp).toBeDefined();
    expect(ramp!.end).toBeLessThan(w.links[out].length);
    expect(ramp!.allowed).toEqual([]);
  });
  it('arterial throughs stay free-flowing while ramp traffic merges', () => {
    const w = w0();
    w.resources.tokens = 3;
    applyCommand(w, { type: 'buildInterchange', nodeId: 'n11', form: 'diamond' });
    run(w, 600);
    const n = w.nodes['n11'];
    const west = inLink(w, 'n11', 3);
    expect((n.metrics.tmcWindow[`${west}:T`] ?? 0) + (n.metrics.tmcLast[`${west}:T`] ?? 0)).toBeGreaterThan(0);
    expect(w.gameOver).toBe(false);
    // No vehicle is stranded in a merge lane past its end.
    for (const link of Object.values(w.links)) for (const lane of link.lanes) if (lane.ramp) for (const id of lane.vehicles) {
      const v = w.vehicles[id];
      if (v.place.kind === 'lane') expect(v.place.pos).toBeLessThanOrEqual(lane.end + 0.01);
    }
  });
  it('removing the interchange removes ramps', () => {
    const w = w0();
    w.resources.tokens = 3;
    applyCommand(w, { type: 'buildInterchange', nodeId: 'n11', form: 'diamond' });
    expect(applyCommand(w, { type: 'transform', nodeId: 'n11', form: 'none' }).ok).toBe(true);
    const west = inLink(w, 'n11', 3);
    expect(w.links[west].pocketRight).toBeNull();
    for (const leg of w.nodes['n11'].legs) if (leg.outLink) expect(w.links[leg.outLink].lanes.some((l) => l.ramp)).toBe(false);
  });
});
