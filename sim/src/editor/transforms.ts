/** Node transforms: roundabouts, median U-turn (MUT), RCUT/superstreet, CFI and interchanges. */
import type { Crossover, LinkId, NodeId, SimNode, World } from '../model/types.js';
import { refreshNodeLegs } from '../network/build.js';
import { generalLanes } from '../network/lanes.js';
import { autoPlan, emptyRuntime, normalisePlan } from '../control/signal.js';
import { rerouteVehicle } from '../routing/routing.js';
import { discardVehicle } from '../traffic/trips.js';
import { fail, ok, setPocket, type Result } from './network-edits.js';
import { indexLane, makeLane, unindexLane } from '../network/lanes.js';
import { mergeLaneInto, renumberLanes } from './network-edits.js';

/** The arterial legs: the opposite pair with the most through lanes. Returns [majorLegs, minorLegs]. */
export function majorMinorLegs(world: World, node: SimNode): [SimNode['legs'], SimNode['legs']] {
  const pair = (a: number, b: number) => node.legs.filter((l) => l.leg === a || l.leg === b);
  const p02 = pair(0, 2);
  const p13 = pair(1, 3);
  const lanes = (ls: SimNode['legs']) => ls.reduce((s, l) => s + (l.inLink ? generalLanes(world.links[l.inLink]).length : 0), 0);
  return lanes(p02) >= lanes(p13) ? [p02, p13] : [p13, p02];
}

function rerouteAffected(world: World, node: SimNode): void {
  for (const v of Object.values(world.vehicles)) {
    if (v.cyclic) continue;
    const idx = v.route.findIndex((l, i) => i >= v.routeIdx && world.links[l]?.to === node.id);
    if (idx < 0) continue;
    if (!rerouteVehicle(world, v)) {
      // Vehicle inside the node on a banned movement: let it finish; on a lane: discard if unroutable.
      if (v.place.kind === 'lane') discardVehicle(world, v);
    }
  }
}

function addCrossover(world: World, roadId: string, pos: number, fwd: boolean, bwd: boolean, signalised: boolean): Crossover {
  const road = world.roads[roadId];
  const xo: Crossover = { id: `${roadId}@${Math.round(pos)}`, roadId, pos, kind: 'uturn', fwd, bwd, signalised, storage: 60, waitingFwd: [], waitingBwd: [] };
  road.crossovers = road.crossovers.filter((x) => x.id !== xo.id);
  road.crossovers.push(xo);
  return xo;
}

function removeCrossovers(world: World, node: SimNode): void {
  for (const leg of node.legs) {
    const road = world.roads[leg.roadId];
    for (const xo of road.crossovers) {
      for (const id of [...xo.waitingFwd, ...xo.waitingBwd]) {
        const v = world.vehicles[id];
        if (v) discardVehicle(world, v);
      }
    }
    road.crossovers = road.crossovers.filter((x) => !x.id.includes(`#${node.id}`));
  }
}

/** Position of a crossover on `road` 150 m downstream of `node` along the road's direction. */
function crossoverPos(world: World, node: SimNode, roadId: string): { pos: number; fwd: boolean; bwd: boolean } {
  const road = world.roads[roadId];
  const d = Math.min(150, road.length * 0.6);
  // Leaving the node forward (node === a) the crossover is at d; leaving backward (node === b) at length − d.
  if (road.a === node.id) return { pos: d, fwd: true, bwd: false };
  return { pos: road.length - d, fwd: false, bwd: true };
}

export function resetForm(world: World, node: SimNode): void {
  node.banned = [];
  node.conflictOverrides = undefined;
  node.form = 'standard';
  removeCrossovers(world, node);
  // Tear down CFI bays and interchange ramps.
  for (const leg of node.legs) {
    if (leg.inLink) {
      const link = world.links[leg.inLink];
      if (link.pocketLeft?.cfi) setPocket(world, link, { side: 'left', storage: 0, source: 'narrow' });
      if (link.pocketRight?.ramp) setPocket(world, link, { side: 'right', storage: 0, source: 'narrow' });
    }
    if (leg.outLink) {
      const out = world.links[leg.outLink];
      const aux = out.lanes.find((l) => l.ramp && l.type === 'general');
      if (aux) {
        const keep = out.lanes.find((l) => l.type === 'general' && l !== aux);
        if (keep) mergeLaneInto(world, aux, keep);
        unindexLane(world, aux);
        out.lanes.splice(out.lanes.indexOf(aux), 1);
        renumberLanes(world, out);
      }
    }
  }
  refreshNodeLegs(world, node);
  if (node.control.signal) normalisePlan(node, world, node.control.signal);
}

export function buildRoundabout(world: World, node: SimNode, lanes: 1 | 2): Result {
  if (node.legs.length < 3) return fail('Roundabouts need at least 3 legs');
  resetForm(world, node);
  node.control = { type: 'roundabout', minorLinks: [], signal: null, runtime: null, roundaboutLanes: lanes };
  node.radius = Math.max(node.radius, lanes === 2 ? 18 : 14);
  // Movement geometry inside a roundabout is longer and slower.
  for (const m of Object.values(node.movements)) {
    const steps = m.turn === 'R' ? 0.5 : m.turn === 'T' ? 1 : m.turn === 'L' ? 1.5 : 2;
    m.length = node.radius * Math.PI * steps * 0.5 + 6;
    m.speed = 7;
  }
  // Peds at roundabouts cross on the legs, away from the circle: treat as unsignalised (already).
  world.structureCounts['roundabout'] = (world.structureCounts['roundabout'] ?? 0) + 1;
  return ok;
}

export function removeRoundabout(world: World, node: SimNode): Result {
  if (node.control.type !== 'roundabout') return fail('Not a roundabout');
  node.control = { type: 'all-way-stop', minorLinks: [], signal: null, runtime: null, roundaboutLanes: 1 };
  refreshNodeLegs(world, node);
  world.structureCounts['roundabout'] = Math.max(0, (world.structureCounts['roundabout'] ?? 0) - 1);
  return ok;
}

/** Median U-turn: ban all lefts and U-turns at the node; add U-turn crossovers downstream on the major road. */
export function buildMut(world: World, node: SimNode): Result {
  const [major] = majorMinorLegs(world, node);
  if (major.length < 2) return fail('Needs a through arterial');
  for (const leg of major) if (world.roads[leg.roadId].median === 'none') return fail(`Road ${leg.roadId} needs a median for crossovers`);
  resetForm(world, node);
  node.form = 'mut-main';
  for (const leg of node.legs) if (leg.inLink) node.banned.push(`${leg.inLink}:L`, `${leg.inLink}:U`);
  for (const leg of major) {
    const { pos, fwd, bwd } = crossoverPos(world, node, leg.roadId);
    const xo = addCrossover(world, leg.roadId, pos, fwd, bwd, false);
    xo.id = `${leg.roadId}@${Math.round(pos)}#${node.id}`;
  }
  refreshNodeLegs(world, node);
  if (node.control.type === 'signal') {
    node.control.signal = autoPlan(node, world, node.control.signal ?? undefined);
    node.control.runtime = emptyRuntime(world.t);
  }
  rerouteAffected(world, node);
  return ok;
}

/** RCUT / superstreet: minor-street through and left are banned; minor traffic turns right and U-turns. */
export function buildRcut(world: World, node: SimNode): Result {
  const [major, minor] = majorMinorLegs(world, node);
  if (major.length < 2 || minor.length < 1) return fail('Needs an arterial and a minor street');
  for (const leg of major) if (world.roads[leg.roadId].median === 'none') return fail(`Road ${leg.roadId} needs a median for crossovers`);
  resetForm(world, node);
  node.form = 'rcut-main';
  for (const leg of minor) if (leg.inLink) node.banned.push(`${leg.inLink}:T`, `${leg.inLink}:L`, `${leg.inLink}:U`);
  for (const leg of major) {
    const { pos, fwd, bwd } = crossoverPos(world, node, leg.roadId);
    const xo = addCrossover(world, leg.roadId, pos, fwd, bwd, true);
    xo.id = `${leg.roadId}@${Math.round(pos)}#${node.id}`;
  }
  refreshNodeLegs(world, node);
  if (node.control.type === 'signal') {
    node.control.signal = autoPlan(node, world, node.control.signal ?? undefined);
    node.control.runtime = emptyRuntime(world.t);
  }
  rerouteAffected(world, node);
  return ok;
}

/** Continuous flow intersection: arterial lefts no longer conflict with the opposing through (they crossed upstream). */
export function buildCfi(world: World, node: SimNode): Result {
  const [major] = majorMinorLegs(world, node);
  if (major.length < 2) return fail('Needs a through arterial');
  for (const leg of major) {
    if (!leg.inLink) continue;
    const link = world.links[leg.inLink];
    if (link.length < 140) return fail(`Block ${link.id} is too short for a displaced-left bay`);
    if (link.pocketLeft && !link.pocketLeft.cfi) return fail('Remove the left-turn pocket first');
  }
  resetForm(world, node);
  node.form = 'cfi-main';
  const overrides: [string, string][] = [];
  const plan = node.control.signal ?? undefined;
  for (const leg of major) {
    if (!leg.inLink) continue;
    const opp = major.find((l) => l !== leg);
    if (!opp?.inLink) continue;
    overrides.push([`${leg.inLink}:L`, `${opp.inLink}:T`], [`${leg.inLink}:L`, `${opp.inLink}:R`], [`${leg.inLink}:U`, `${opp.inLink}:T`]);
    // The displaced-left bay runs from the pre-signal crossover to the node.
    const link = world.links[leg.inLink];
    const road = world.roads[leg.roadId];
    const d = Math.min(100, link.length * 0.5);
    const r = setPocket(world, link, { side: 'left', storage: d, source: road.median !== 'none' ? 'median' : 'narrow' });
    if (!r.ok) return r;
    link.pocketLeft!.cfi = true;
    const pos = road.b === node.id ? road.length - d : d;
    road.crossovers.push({ id: `${road.id}@${Math.round(pos)}#${node.id}`, roadId: road.id, pos, kind: 'cfi-presignal', fwd: road.b === node.id, bwd: road.a === node.id, signalised: true, storage: d, waitingFwd: [], waitingBwd: [], mainNode: node.id, approachLink: link.id });
    if (plan) plan.leftTreatment[link.id] = 'permitted'; // lefts run with their own through, unopposed
  }
  node.conflictOverrides = overrides;
  refreshNodeLegs(world, node);
  if (node.control.type !== 'signal') node.control = { type: 'signal', minorLinks: [], signal: null, runtime: null, roundaboutLanes: 1 };
  const base = node.control.signal ?? autoPlan(node, world);
  for (const leg of major) if (leg.inLink) base.leftTreatment[leg.inLink] = 'permitted';
  node.control.signal = autoPlan(node, world, base);
  node.control.runtime = emptyRuntime(world.t);
  return ok;
}

/**
 * Interchange: the major road's through movements are grade separated (free flow, no conflicts);
 * everything else is a signalised ramp terminal. Forms differ in how lefts are handled.
 */
export function buildInterchange(world: World, node: SimNode, form: 'diamond' | 'spui' | 'ddi' | 'parclo'): Result {
  const [major, minor] = majorMinorLegs(world, node);
  if (major.length < 2 || minor.length < 2) return fail('Interchanges need a full 4-leg crossing');
  resetForm(world, node);
  node.form = form === 'ddi' ? 'ddi-terminal' : 'interchange-terminal';
  const overrides: [string, string][] = [];
  const all = Object.keys(node.movements);
  for (const leg of major) {
    if (!leg.inLink) continue;
    const t = `${leg.inLink}:T`;
    overrides.push([t, '*']);
    for (const other of all) if (other !== t) overrides.push([t, other]);
  }
  if (form === 'ddi') {
    // Lefts from the crossing street onto ramps are free of the opposing through.
    for (const leg of minor) {
      if (!leg.inLink) continue;
      const opp = minor.find((l) => l !== leg);
      if (opp?.inLink) overrides.push([`${leg.inLink}:L`, `${opp.inLink}:T`]);
    }
  }
  if (form === 'parclo') {
    // Loop ramps remove major-road lefts entirely: they become right turns downstream.
    for (const leg of major) if (leg.inLink) node.banned.push(`${leg.inLink}:L`);
  }
  node.conflictOverrides = overrides;
  // Ramps: an off-ramp pocket on each major approach carries every exiting movement;
  // an on-ramp merge lane on each major departure receives cross-street traffic.
  for (const leg of major) {
    if (leg.inLink) {
      const link = world.links[leg.inLink];
      if (link.pocketRight && !link.pocketRight.ramp) return fail('Remove the right-turn pocket first');
      const r = setPocket(world, link, { side: 'right', storage: Math.min(150, Math.max(40, link.length - 60)), source: 'narrow' });
      if (!r.ok) return r;
      link.pocketRight!.ramp = true;
      link.pocketRight!.allowed = form === 'parclo' ? ['R'] : ['R', 'L', 'U'];
      link.pocketRight!.width = 3.5;
      for (const l of link.lanes) if (l.type === 'general') { l.allowed = ['T']; l.width = 3.5; }
    }
    if (leg.outLink) {
      const out = world.links[leg.outLink];
      if (!out.lanes.some((l) => l.ramp)) {
        const general = out.lanes.filter((l) => l.type === 'general');
        const lane = makeLane(out.id, out.lanes.length, 'general', 0, Math.min(150, out.length - 30), []);
        lane.ramp = true;
        out.lanes.splice(out.lanes.indexOf(general[general.length - 1]) + 1, 0, lane);
        indexLane(world, lane);
        renumberLanes(world, out);
      }
    }
  }
  refreshNodeLegs(world, node);
  node.control = { type: 'signal', minorLinks: [], signal: null, runtime: null, roundaboutLanes: 1 };
  node.control.signal = autoPlan(node, world);
  // Through movements on the bridge need no phase; drop them from the plan.
  for (const ph of node.control.signal.phases) ph.movements = ph.movements.filter((k) => !overrides.some(([a, b]) => a === k && b === '*'));
  normalisePlan(node, world, node.control.signal);
  node.control.runtime = emptyRuntime(world.t);
  const bridgeLinks: LinkId[] = major.flatMap((l) => (l.inLink ? [l.inLink] : []));
  world.interchanges[node.id] = { bridgeLinks, terminals: [node.id], form };
  world.structureCounts['interchange'] = (world.structureCounts['interchange'] ?? 0) + 1;
  rerouteAffected(world, node);
  return ok;
}

export function removeTransform(world: World, nodeId: NodeId): Result {
  const node = world.nodes[nodeId];
  if (!node) return fail('No such node');
  if (world.interchanges[node.id]) {
    delete world.interchanges[node.id];
    world.structureCounts['interchange'] = Math.max(0, (world.structureCounts['interchange'] ?? 0) - 1);
  }
  resetForm(world, node);
  if (node.control.type === 'signal' && node.control.signal) {
    node.control.signal = autoPlan(node, world, node.control.signal);
    node.control.runtime = emptyRuntime(world.t);
  }
  rerouteAffected(world, node);
  return ok;
}
