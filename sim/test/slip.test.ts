import { describe, expect, it } from 'vitest';
import { buildWorld } from '../src/network/build.js';
import { tutorialMap } from '../src/maps/tutorial.js';
import { applyCommand, SLIP_COST_KM } from '../src/editor/commands.js';
import { tick } from '../src/game/tick.js';
import { generalLanes } from '../src/network/lanes.js';

const w0 = () => {
  const w = buildWorld(tutorialMap(), 5);
  w.t = 0.3 * w.config.dayLength;
  return w;
};
const run = (w: ReturnType<typeof buildWorld>, s: number) => {
  for (let i = 0; i < Math.round(s / w.config.tickDt); i++) tick(w);
};

describe('slip lanes', () => {
  it('creates a right-side slip lane, removes R from the through lanes, and costs lane-km', () => {
    const w = w0();
    const before = w.resources.laneKm;
    const west = w.nodes['n11'].legs.find((l) => l.leg === 3)!;
    const r = applyCommand(w, { type: 'setChannelisedRight', nodeId: 'n11', leg: 3, on: true });
    expect(r.ok).toBe(true);
    const link = w.links[west.inLink!];
    expect(link.pocketRight?.slip).toBe(true);
    expect(link.pocketRight?.allowed).toEqual(['R']);
    for (const l of generalLanes(link)) expect(l.allowed.includes('R')).toBe(false);
    expect(before - w.resources.laneKm).toBeCloseTo(SLIP_COST_KM, 6);
    // Removing refunds and restores the right turn.
    expect(applyCommand(w, { type: 'setChannelisedRight', nodeId: 'n11', leg: 3, on: false }).ok).toBe(true);
    expect(link.pocketRight).toBeNull();
    expect(w.resources.laneKm).toBeCloseTo(before, 6);
    expect(generalLanes(link).some((l) => l.allowed.includes('R'))).toBe(true);
  });
  it('slip movement has no vehicle conflicts, only a soft ped conflict on the exit leg', () => {
    const w = w0();
    applyCommand(w, { type: 'setChannelisedRight', nodeId: 'n11', leg: 3, on: true });
    const n = w.nodes['n11'];
    const west = n.legs.find((l) => l.leg === 3)!.inLink!;
    const key = `${west}:R`;
    expect(n.movements[key].slip).toBe(true);
    for (const other of Object.keys(n.movements)) if (other !== key) expect(n.conflicts[key][other]).toBe('none');
    expect(n.conflicts[key]['ped:2']).toBe('ped-soft'); // a right from the west exits south
    expect(n.conflicts[key]['ped:3']).toBe('none'); // island separates it from its own leg's crossing
  });
  it('the island shortens the main crossing and the slip movement is in no signal phase', () => {
    const w = w0();
    const widthBefore = w.nodes['n11'].peds['ped:3'].width;
    applyCommand(w, { type: 'setChannelisedRight', nodeId: 'n11', leg: 3, on: true });
    expect(w.nodes['n11'].peds['ped:3'].width).toBeCloseTo(widthBefore - 3.5, 5);
    applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    const west = w.nodes['n11'].legs.find((l) => l.leg === 3)!.inLink!;
    for (const ph of w.nodes['n11'].control.signal!.phases) expect(ph.movements.includes(`${west}:R`)).toBe(false);
  });
  it('right-turners use the slip lane and keep moving while their approach is red', () => {
    const w = w0();
    applyCommand(w, { type: 'setChannelisedRight', nodeId: 'n11', leg: 3, on: true });
    applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    const n = w.nodes['n11'];
    const west = n.legs.find((l) => l.leg === 3)!.inLink!;
    run(w, 900);
    const served = n.metrics.tmcWindow[`${west}:R`] ?? 0;
    expect(served).toBeGreaterThan(0);
    expect(w.gameOver).toBe(false);
    // Nothing is stuck in the slip lane for long.
    const slip = w.links[west].pocketRight!;
    for (const id of slip.vehicles) expect(w.t - w.vehicles[id].stopLineArrival < 120 || w.vehicles[id].stopLineArrival === 0).toBe(true);
  });
  it('rejects a slip lane on a tight corner and at a roundabout', () => {
    const w = w0();
    applyCommand(w, { type: 'setCornerRadius', nodeId: 'n11', leg: 3, radius: 'tight' });
    expect(applyCommand(w, { type: 'setChannelisedRight', nodeId: 'n11', leg: 3, on: true }).ok).toBe(false);
    applyCommand(w, { type: 'setCornerRadius', nodeId: 'n11', leg: 3, radius: 'standard' });
    w.resources.tokens = 1;
    applyCommand(w, { type: 'buildRoundabout', nodeId: 'n11', lanes: 1 });
    expect(applyCommand(w, { type: 'setChannelisedRight', nodeId: 'n11', leg: 3, on: true }).ok).toBe(false);
  });
  it('free-flow mode has higher capacity than yield', () => {
    const w = w0();
    applyCommand(w, { type: 'setChannelisedRight', nodeId: 'n11', leg: 3, on: true, mode: 'yield' });
    run(w, 120);
    const west = w.nodes['n11'].legs.find((l) => l.leg === 3)!.inLink!;
    const yieldCap = w.nodes['n11'].metrics.capacity[`${west}:R`];
    applyCommand(w, { type: 'setChannelisedRight', nodeId: 'n11', leg: 3, on: false });
    applyCommand(w, { type: 'setChannelisedRight', nodeId: 'n11', leg: 3, on: true, mode: 'free' });
    run(w, 60);
    expect(w.nodes['n11'].metrics.capacity[`${west}:R`]).toBeGreaterThanOrEqual(yieldCap);
  });
});
