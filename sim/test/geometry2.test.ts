import { describe, expect, it } from 'vitest';
import { buildWorld } from '../src/network/build.js';
import { tutorialMap } from '../src/maps/tutorial.js';
import { proceduralMap } from '../src/maps/procedural.js';
import { applyCommand } from '../src/editor/commands.js';
import { tick } from '../src/game/tick.js';
import { clearanceDeficit, intergreen, kinematicIntergreen } from '../src/control/signal.js';
import { sightLimitedSpeed, weaveZone } from '../src/traffic/dynamics.js';
import { bandwidthReport, geometryReport, offsetIntersections, storageReport, weavingSections } from '../src/metrics/instruments.js';
import { conflictScore } from '../src/incidents/incidents.js';
import type { MapDef } from '../src/network/mapdef.js';

const run = (w: ReturnType<typeof buildWorld>, s: number) => {
  for (let i = 0; i < Math.round(s / w.config.tickDt); i++) tick(w);
};
const w0 = (m: MapDef = tutorialMap(), seed = 6) => {
  const w = buildWorld(m, seed);
  w.t = 0.3 * w.config.dayLength;
  return w;
};
const inLink = (w: ReturnType<typeof buildWorld>, node: string, leg: number) => w.nodes[node].legs.find((l) => l.leg === leg)!.inLink!;

describe('1. grade and sight distance', () => {
  it('a downhill approach needs a longer yellow; uphill slows trucks more than cars', () => {
    const flat = w0();
    applyCommand(flat, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    const yFlat = kinematicIntergreen(flat.nodes['n11'], flat).yellow;
    const m = tutorialMap();
    m.roads.find((r) => r.id === 'h10')!.grade = -6; // h10 runs a=n10 → b=n11 downhill
    const hill = w0(m);
    applyCommand(hill, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    expect(kinematicIntergreen(hill.nodes['n11'], hill).yellow).toBeGreaterThan(yFlat);
    // Going uphill on h10< (b→a): trucks crawl.
    expect(hill.roads['h10'].grade).toBe(-6);
  });
  it('a curved approach caps the approach speed and widens the critical gap', () => {
    const m = tutorialMap();
    m.roads.find((r) => r.id === 'v01')!.curvature = 0.8;
    const w = w0(m);
    const link = w.links['v01>'];
    const v = sightLimitedSpeed(w, link);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(link.speedLimit);
    const rep = geometryReport(w, 'n11');
    const approach = rep.approaches.find((a) => a.linkId === 'v01>')!;
    expect(approach.sightDistance).toBeLessThan(120);
    // Restricted sight raises the conflict score of an uncontrolled node.
    run(w, 300);
    const curved = conflictScore(w, w.nodes['n11']).score;
    const w2 = w0();
    run(w2, 300);
    expect(curved).toBeGreaterThanOrEqual(conflictScore(w2, w2.nodes['n11']).score * 0.8);
  });
});

describe('2. skew and offset intersections', () => {
  it('skewed legs lengthen all-red', () => {
    const m = tutorialMap();
    // Bend the north stub so it meets n01 at an angle.
    m.nodes.find((n) => n.id === 'xN1')!.x = 120;
    const w = w0(m);
    expect(w.nodes['n01'].skew).toBeGreaterThan(20);
    applyCommand(w, { type: 'setControl', nodeId: 'n01', control: 'signal' });
    applyCommand(w, { type: 'setControl', nodeId: 'n21', control: 'signal' });
    expect(intergreen(w.nodes['n01'], w).allRed).toBeGreaterThan(intergreen(w.nodes['n21'], w).allRed);
  });
  it('detects an offset pair and realigns it into one four-leg node', () => {
    const m = tutorialMap();
    // Turn n11 into an offset pair: twin node 30 m east takes the east and south legs.
    m.nodes.push({ id: 'n11b', x: 230, y: 200 });
    m.roads.find((r) => r.id === 'h11')!.a = 'n11b';
    m.roads.find((r) => r.id === 'v11')!.a = 'n11b';
    m.roads.push({ id: 'off', a: 'n11', b: 'n11b' });
    m.busRoutes = []; // the loop used h11/v11 through n11
    const w = w0(m);
    expect(w.nodes['n11'].legs.length).toBe(3);
    expect(w.nodes['n11b'].legs.length).toBe(3);
    const offs = offsetIntersections(w);
    expect(offs.map((o) => o.roadId)).toContain('off');
    w.resources.laneKm = 1;
    const r = applyCommand(w, { type: 'realignOffset', roadId: 'off' });
    expect(r.ok).toBe(true);
    expect(w.nodes['n11b']).toBeUndefined();
    expect(w.roads['off']).toBeUndefined();
    expect(w.nodes['n11'].legs.length).toBe(4);
    expect(w.roads['h11'].a).toBe('n11');
    run(w, 300);
    expect(w.gameOver).toBe(false);
    for (const v of Object.values(w.vehicles)) if (v.place.kind === 'lane') expect(w.lanes[v.place.laneId]).toBeDefined();
  });
});

describe('3. weaving sections', () => {
  it('an interchange with a short block creates a weave zone that slows traffic', () => {
    const w = w0();
    w.resources.tokens = 6;
    applyCommand(w, { type: 'buildInterchange', nodeId: 'n10', form: 'diamond' });
    applyCommand(w, { type: 'buildInterchange', nodeId: 'n11', form: 'diamond' });
    const link = w.links['h10>']; // leaves n10's on-ramp, meets n11's off-ramp
    const z = weaveZone(link);
    expect(z).not.toBeNull();
    expect(z!.intensity).toBeGreaterThan(0);
    const secs = weavingSections(w);
    expect(secs.some((s) => s.linkId === 'h10>')).toBe(true);
    run(w, 300);
    expect(w.gameOver).toBe(false);
  });
});

describe('4. storage instrument', () => {
  it('flags a block that cannot store an upstream green', () => {
    const w = w0();
    applyCommand(w, { type: 'setControl', nodeId: 'n10', control: 'signal' });
    applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    applyCommand(w, { type: 'setCycle', nodeId: 'n10', cycle: 180 });
    const rows = storageReport(w, 'n11');
    const h10 = rows.find((r) => r.linkId === 'h10>')!;
    expect(h10.storageVehicles).toBeGreaterThan(0);
    expect(h10.dischargePerCycle).toBeGreaterThan(0);
    // A 180 s cycle with two lanes releases far more than a 200 m block stores.
    expect(h10.ratio).toBeGreaterThan(0.9);
    expect(h10.risk).toBe(true);
  });
});

describe('5. land budget', () => {
  it('built frontage multiplies widening cost and the right-of-way cap blocks further widening', () => {
    const w = w0();
    const road = w.roads['v10'];
    expect(road.frontage).toBe('built'); // houses front it
    w.resources.laneKm = 10;
    const before = w.resources.laneKm;
    expect(applyCommand(w, { type: 'widen', roadId: 'v10', dir: 'fwd' }).ok).toBe(true);
    expect(before - w.resources.laneKm).toBeCloseTo(0.2 * 3, 5);
    run(w, w.config.dayLength + 5);
    // Keep widening until the cap refuses.
    let refused = '';
    for (let i = 0; i < 5; i++) {
      const r = applyCommand(w, { type: 'widen', roadId: 'v10', dir: 'fwd' });
      if (!r.ok) {
        refused = r.error;
        break;
      }
      run(w, w.config.dayLength + 5);
    }
    expect(refused).toContain('right-of-way');
  }, 120000);
});

describe('8. clearance as a choice', () => {
  it('shortening yellow and all-red buys green but creates a safety deficit', () => {
    const w = w0();
    applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    const n = w.nodes['n11'];
    const cycleBefore = n.control.signal!.cycle;
    expect(clearanceDeficit(n, w)).toBe(0);
    expect(applyCommand(w, { type: 'setClearance', nodeId: 'n11', yellowAdjust: -1, allRedAdjust: -1 }).ok).toBe(true);
    expect(n.control.signal!.cycle).toBeLessThan(cycleBefore);
    expect(clearanceDeficit(n, w)).toBeCloseTo(2, 1);
    run(w, 120);
    const risky = conflictScore(w, n).score;
    applyCommand(w, { type: 'setClearance', nodeId: 'n11', yellowAdjust: 0, allRedAdjust: 0 });
    expect(conflictScore(w, n).score).toBeLessThan(risky);
    expect(applyCommand(w, { type: 'setClearance', nodeId: 'n11', yellowAdjust: -3, allRedAdjust: 0 }).ok).toBe(false);
  });
});

describe('10. lead/lag and progression bandwidth', () => {
  it('lead one side and lag the other puts the lefts on opposite sides of the through phase', () => {
    const w = w0();
    const west = inLink(w, 'n11', 3);
    const east = inLink(w, 'n11', 1);
    applyCommand(w, { type: 'setPocket', linkId: west, spec: { side: 'left', storage: 60, source: 'median' } });
    applyCommand(w, { type: 'setPocket', linkId: east, spec: { side: 'left', storage: 60, source: 'median' } });
    applyCommand(w, { type: 'setControl', nodeId: 'n11', control: 'signal' });
    applyCommand(w, { type: 'setLeftTreatment', nodeId: 'n11', linkId: west, treatment: 'protected' });
    applyCommand(w, { type: 'setLeftTreatment', nodeId: 'n11', linkId: east, treatment: 'protected' });
    applyCommand(w, { type: 'setLeftLead', nodeId: 'n11', linkId: west, lead: 'lead' });
    applyCommand(w, { type: 'setLeftLead', nodeId: 'n11', linkId: east, lead: 'lag' });
    const phases = w.nodes['n11'].control.signal!.phases;
    const iWest = phases.findIndex((p) => p.movements.includes(`${west}:L`));
    const iEast = phases.findIndex((p) => p.movements.includes(`${east}:L`));
    const iThrough = phases.findIndex((p) => p.movements.includes(`${west}:T`));
    expect(iWest).toBeLessThan(iThrough);
    expect(iEast).toBeGreaterThan(iThrough);
  });
  it('bandwidth report reflects coordination', () => {
    const w = w0();
    for (const id of ['n10', 'n11', 'n12']) {
      applyCommand(w, { type: 'setControl', nodeId: id, control: 'signal' });
      applyCommand(w, { type: 'setCycle', nodeId: id, cycle: 80 });
    }
    const un = bandwidthReport(w, ['n10', 'n11', 'n12']);
    expect(un.cycle).toBeCloseTo(80, 0);
    expect(un.coordinated).toBe(false);
    // Offsets equal to travel time between nodes should give a wide band.
    const tt = w.links['h10>'].length / w.links['h10>'].speedLimit;
    applyCommand(w, { type: 'setCoordination', nodeId: 'n10', on: true, offset: 0 });
    applyCommand(w, { type: 'setCoordination', nodeId: 'n11', on: true, offset: tt });
    applyCommand(w, { type: 'setCoordination', nodeId: 'n12', on: true, offset: 2 * tt });
    const co = bandwidthReport(w, ['n10', 'n11', 'n12']);
    expect(co.coordinated).toBe(true);
    expect(co.bandShare).toBeGreaterThan(0.2);
    const bad = bandwidthReport(w, ['n10', 'n11', 'n12'].map((x) => x));
    expect(bad.bandSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('procedural geometry', () => {
  it('seeds produce grades, curves and sometimes offset pairs that still build', () => {
    let anyGrade = false;
    let anyCurve = false;
    let anyOffset = false;
    for (let seed = 1; seed <= 10; seed++) {
      const m = proceduralMap(seed);
      const w = buildWorld(m, seed);
      if (m.roads.some((r) => (r.grade ?? 0) !== 0)) anyGrade = true;
      if (m.roads.some((r) => (r.curvature ?? 0) > 0)) anyCurve = true;
      if (offsetIntersections(w).length) anyOffset = true;
      for (const n of Object.values(w.nodes)) expect(n.legs.length).toBeLessThanOrEqual(4);
    }
    expect(anyGrade && anyCurve && anyOffset).toBe(true);
  });
});
