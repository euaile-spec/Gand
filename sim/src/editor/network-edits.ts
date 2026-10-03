/** Structural edits to links and lanes, keeping vehicles, indexes and signal plans consistent. */
import { LANE_WIDTH_NARROW, LANE_WIDTH_STANDARD, type Lane, type LaneId, type Link, type LinkId, type Road, type Turn, type World } from '../model/types.js';
import { createLink, recomputeLegs, refreshNodeLegs } from '../network/build.js';
import { autoPlan } from '../control/signal.js';
import { defaultAllowed, generalLanes, indexLane, makeLane, refreshLinkSpeed, unindexLane } from '../network/lanes.js';
import { addToLane, posOf, removeFromLane } from '../traffic/access.js';
import { discardVehicle } from '../traffic/trips.js';
import { rerouteVehicle } from '../routing/routing.js';
import { normalisePlan } from '../control/signal.js';

export type Result = { ok: true } | { ok: false; error: string };
export const ok: Result = { ok: true };
export const fail = (error: string): Result => ({ ok: false, error });

/** Move every vehicle from `from` into `to` at the same position. */
export function mergeLaneInto(world: World, from: Lane, to: Lane): void {
  for (const id of [...from.vehicles]) {
    const v = world.vehicles[id];
    if (!v) continue;
    const pos = posOf(world, id);
    removeFromLane(world, from, v);
    addToLane(world, to, v, Math.min(Math.max(pos, to.start), to.end));
  }
}

/** Re-index lanes left→right and regenerate ids; fix vehicle places and detector references. */
export function renumberLanes(world: World, link: Link): void {
  const rename = new Map<LaneId, LaneId>();
  link.lanes.forEach((lane, i) => {
    const oldId = lane.id;
    unindexLane(world, lane);
    lane.index = i;
    lane.id = `${link.id}#${i}`;
    if (oldId !== lane.id) rename.set(oldId, lane.id);
  });
  for (const lane of link.lanes) indexLane(world, lane);
  if (link.pocketRight) link.pocketRight.index = link.lanes.filter((l) => l.type !== 'parking').length;
  if (!rename.size) return;
  for (const lane of link.lanes) {
    for (const id of lane.vehicles) {
      const v = world.vehicles[id];
      if (v && v.place.kind === 'lane') v.place.laneId = lane.id;
    }
  }
  for (const node of Object.values(world.nodes)) {
    const plan = node.control.signal;
    if (!plan) continue;
    for (const d of plan.detectors) d.laneId = rename.get(d.laneId) ?? d.laneId;
    plan.detectors = plan.detectors.filter((d) => world.lanes[d.laneId]);
  }
  for (const [oldId, newId] of rename) {
    const r = world.metrics.queueHistory[oldId];
    if (r) {
      world.metrics.queueHistory[newId] = r;
      delete world.metrics.queueHistory[oldId];
    }
  }
}

/** Reset turn permissions to defaults for the general lanes of a link (used after lane count changes). */
export function resetDefaultTurns(link: Link): void {
  const general = generalLanes(link);
  general.forEach((l, i) => (l.allowed = defaultAllowed(general.length, i)));
  if (link.pocketLeft) for (const l of general) l.allowed = l.allowed.filter((t) => t !== 'L' && t !== 'U');
  if (link.pocketRight) for (const l of general) l.allowed = l.allowed.filter((t) => t !== 'R');
  // An off-ramp takes every exiting movement; the mainline keeps only the through.
  if (link.pocketRight?.ramp) for (const l of general) l.allowed = ['T'];
  // A single general lane must still be able to do everything the pockets don't.
  if (general.length === 1 && !general[0].allowed.includes('T')) general[0].allowed.push('T');
}

/** Set the number of general lanes on a link (adds at the right / removes the rightmost). */
export function setGeneralLaneCount(world: World, link: Link, n: number): void {
  let general = generalLanes(link);
  while (general.length < n) {
    const insertAt = link.lanes.indexOf(general[general.length - 1]) + 1;
    const lane = makeLane(link.id, link.lanes.length, 'general', 0, link.length, ['T']);
    link.lanes.splice(insertAt < 0 ? link.lanes.length : insertAt, 0, lane);
    indexLane(world, lane);
    general = generalLanes(link);
  }
  while (general.length > n && general.length > 1) {
    const victim = general[general.length - 1];
    const keep = general[general.length - 2];
    mergeLaneInto(world, victim, keep);
    unindexLane(world, victim);
    link.lanes.splice(link.lanes.indexOf(victim), 1);
    general = generalLanes(link);
  }
  renumberLanes(world, link);
  resetDefaultTurns(link);
  refreshLinkSpeed(world, link);
  // Nodes at both ends depend on this link's lanes.
  refreshNodeLegs(world, world.nodes[link.from]);
  refreshNodeLegs(world, world.nodes[link.to]);
  renormaliseSignals(world, [link.from, link.to]);
}

export function renormaliseSignals(world: World, nodeIds: string[]): void {
  for (const id of nodeIds) {
    const node = world.nodes[id];
    if (node?.control.signal) normalisePlan(node, world, node.control.signal);
  }
}

/** Lane units consumed by a road's current cross-section. */
export function usedWidth(world: World, road: Road): number {
  const f = world.links[`${road.id}>`];
  const b = world.links[`${road.id}<`];
  let w = 0;
  for (const l of [f, b]) {
    if (!l) continue;
    w += l.lanes.filter((x) => x.type !== 'parking').length;
    if (l.parking !== 'none') w += 1;
    if (l.pocketLeft && !l.pocketLeft.width) w += 0;
  }
  if (road.median !== 'none') w += 1;
  return w;
}

/** Change lanes per direction (tidal flow). Free; must fit the physical width. */
export function reallocate(world: World, road: Road, fwd: number, bwd: number): Result {
  if (fwd < 0 || bwd < 0 || (fwd === 0 && bwd === 0)) return fail('At least one lane');
  if (road.oneWay === 'fwd' && bwd > 0) return fail('Road is one-way forward');
  if (road.oneWay === 'bwd' && fwd > 0) return fail('Road is one-way backward');
  if (road.oneWay === 'none' && (fwd === 0 || bwd === 0)) return fail('Use one-way conversion to remove a direction');
  const f = world.links[`${road.id}>`];
  const b = world.links[`${road.id}<`];
  const other = (l: Link | undefined): number => (l ? l.lanes.filter((x) => x.type !== 'parking' && x.type !== 'general').length + (l.parking !== 'none' ? 1 : 0) : 0);
  const need = fwd + bwd + other(f) + other(b) + (road.median !== 'none' ? 1 : 0);
  if (need > road.widthLanes) return fail(`Needs ${need} lane units; road has ${road.widthLanes}`);
  if (f && fwd > 0) setGeneralLaneCount(world, f, fwd);
  if (b && bwd > 0) setGeneralLaneCount(world, b, bwd);
  road.fwdLanes = fwd;
  road.bwdLanes = bwd;
  return ok;
}

/** Physically widen a road by one lane unit and give it to `dir` (applied on construction completion). */
export function applyWiden(world: World, road: Road, dir: 'fwd' | 'bwd'): void {
  road.widthLanes += 1;
  const link = world.links[dir === 'fwd' ? `${road.id}>` : `${road.id}<`];
  if (!link) return;
  const n = generalLanes(link).length + 1;
  setGeneralLaneCount(world, link, n);
  if (dir === 'fwd') road.fwdLanes = n;
  else road.bwdLanes = n;
  refreshLinkSpeed(world, link);
}

export function removeLane(world: World, road: Road, dir: 'fwd' | 'bwd'): Result {
  const link = world.links[dir === 'fwd' ? `${road.id}>` : `${road.id}<`];
  if (!link) return fail('No such direction');
  const n = generalLanes(link).length;
  if (n <= 1) return fail('Cannot remove the last lane');
  setGeneralLaneCount(world, link, n - 1);
  road.widthLanes -= 1;
  if (dir === 'fwd') road.fwdLanes = n - 1;
  else road.bwdLanes = n - 1;
  return ok;
}

/** Convert a general lane to a bus/bike lane or back. */
export function setLaneType(world: World, lane: Lane, type: 'general' | 'bus' | 'bike', protectedBus = false): Result {
  const link = world.links[lane.linkId];
  if (lane.type === 'parking' || lane.type === 'pocket' || lane.type === 'bay') return fail('Not a travel lane');
  const general = generalLanes(link);
  if (type !== 'general' && lane.type === 'general' && general.length <= 1) return fail('Keep at least one general lane');
  if (type === 'bike') {
    // Bikes are off the carriageway model: vehicles in the lane merge out.
    const neighbour = general.find((l) => l !== lane);
    if (neighbour) mergeLaneInto(world, lane, neighbour);
    lane.allowed = [];
  }
  lane.type = type;
  lane.protectedBus = type === 'bus' ? protectedBus : undefined;
  if (type === 'bus') {
    const neighbour = general.find((l) => l !== lane);
    if (neighbour) {
      // Cars must leave; buses may stay.
      for (const id of [...lane.vehicles]) {
        const v = world.vehicles[id];
        if (v && v.cls !== 'bus' && v.cls !== 'emergency') {
          const pos = posOf(world, id);
          removeFromLane(world, lane, v);
          addToLane(world, neighbour, v, pos);
        }
      }
    }
    lane.allowed = lane.allowed.length ? lane.allowed : ['T', 'R'];
  }
  resetDefaultTurns(link);
  if (type === 'bus' && !lane.allowed.length) lane.allowed = ['T', 'R'];
  refreshNodeLegs(world, world.nodes[link.to]);
  renormaliseSignals(world, [link.to]);
  return ok;
}

export function setParking(world: World, link: Link, mode: Link['parking']): Result {
  const road = world.roads[link.roadId];
  const parkingLane = link.lanes.find((l) => l.type === 'parking');
  if (mode === 'none') {
    if (!parkingLane) {
      link.parking = 'none';
      return ok;
    }
    // Removing parking gives a travel lane.
    parkingLane.type = 'general';
    parkingLane.width = LANE_WIDTH_STANDARD;
    link.parking = 'none';
    renumberLanes(world, link);
    resetDefaultTurns(link);
    road[link.id.endsWith('>') ? 'fwdLanes' : 'bwdLanes'] = generalLanes(link).length;
  } else {
    if (!parkingLane) {
      const general = generalLanes(link);
      if (general.length <= 1) return fail('Need two travel lanes to give one to parking');
      const victim = general[general.length - 1];
      mergeLaneInto(world, victim, general[general.length - 2]);
      victim.type = 'parking';
      victim.allowed = [];
      victim.width = 2.5;
      renumberLanes(world, link);
      resetDefaultTurns(link);
      road[link.id.endsWith('>') ? 'fwdLanes' : 'bwdLanes'] = generalLanes(link).length;
    }
    link.parking = mode;
  }
  refreshLinkSpeed(world, link);
  refreshNodeLegs(world, world.nodes[link.to]);
  renormaliseSignals(world, [link.to]);
  return ok;
}

export interface PocketSpec {
  side: 'left' | 'right';
  storage: number; // 0 removes
  source: 'narrow' | 'median' | 'parking';
  busOnly?: boolean;
}

export function pocketCostMetres(storage: number, freeTaper: number): number {
  return Math.max(0, storage - freeTaper);
}

export function setPocket(world: World, link: Link, spec: PocketSpec): Result {
  const road = world.roads[link.roadId];
  const existing = spec.side === 'left' ? link.pocketLeft : link.pocketRight;
  const general = generalLanes(link);
  if (spec.storage > 0) {
    if (spec.storage > link.length - 40) return fail(`Block is too short for ${spec.storage} m of storage`);
    if (spec.source === 'median' && road.median === 'none') return fail('No median to take width from');
    if (spec.source === 'median' && spec.side === 'right') return fail('Median width only serves a left pocket');
    if (spec.source === 'parking' && link.parking === 'none') return fail('No parking lane to take width from');
    if (spec.source === 'parking' && spec.side === 'left') return fail('Parking width only serves a right pocket');
  }
  // Remove existing
  if (existing) {
    const adj = spec.side === 'left' ? general[0] : general[general.length - 1];
    mergeLaneInto(world, existing, adj);
    unindexLane(world, existing);
    if (spec.side === 'left') link.pocketLeft = null;
    else link.pocketRight = null;
    for (const l of general) l.width = LANE_WIDTH_STANDARD;
  }
  if (spec.storage > 0) {
    const index = spec.side === 'left' ? -1 : link.lanes.filter((l) => l.type !== 'parking').length;
    const allowed: Turn[] = spec.side === 'left' ? ['L', 'U'] : ['R'];
    const lane = makeLane(link.id, index, 'pocket', Math.max(0, link.length - spec.storage), link.length, allowed, spec.source === 'narrow' ? LANE_WIDTH_NARROW : LANE_WIDTH_STANDARD);
    lane.busOnly = spec.busOnly ?? false;
    if (spec.source === 'narrow') for (const l of general) l.width = LANE_WIDTH_NARROW;
    indexLane(world, lane);
    if (spec.side === 'left') link.pocketLeft = lane;
    else link.pocketRight = lane;
  }
  resetDefaultTurns(link);
  refreshLinkSpeed(world, link);
  refreshNodeLegs(world, world.nodes[link.to]);
  renormaliseSignals(world, [link.to]);
  return ok;
}

export const SLIP_STORAGE_DEFAULT = 40;

/** Land cost multiplier for adding pavement along a road. */
export function frontageMultiplier(road: Road): number {
  switch (road.frontage) {
    case 'open':
      return 1;
    case 'parkland':
      return 2;
    case 'built':
      return 3;
    case 'water':
      return 6;
  }
}

/** Offset intersection: a very short road joining two 3-leg nodes — a pair of T-junctions that should be one crossing. */
export function isOffsetPair(world: World, road: Road): boolean {
  if (road.length > 60) return false;
  const a = world.nodes[road.a];
  const b = world.nodes[road.b];
  return !!a && !!b && a.legs.length === 3 && b.legs.length === 3;
}

/**
 * Realign an offset pair into one four-leg node: the short road is removed and node b's other roads
 * are re-attached to node a (node a keeps its control). Vehicles on the short road are discarded.
 */
export function realignOffset(world: World, road: Road): Result {
  if (!isOffsetPair(world, road)) return fail('Not an offset pair of T-junctions (short road between two 3-leg nodes)');
  const keep = world.nodes[road.a];
  const drop = world.nodes[road.b];
  if (keep.control.type === 'roundabout' || drop.control.type === 'roundabout') return fail('Remove roundabouts first');
  for (const r of Object.values(world.busRoutes)) if (r.links.includes(`${road.id}>`) || r.links.includes(`${road.id}<`)) return fail(`Bus route ${r.id} uses the short link`);
  // Evict vehicles on the short road and in the dropped node.
  for (const id of [`${road.id}>`, `${road.id}<`]) {
    const link = world.links[id];
    if (!link) continue;
    for (const lane of [link.pocketLeft, ...link.lanes, link.pocketRight, ...link.bays]) {
      if (!lane) continue;
      for (const vid of [...lane.vehicles]) {
        const v = world.vehicles[vid];
        if (v) discardVehicle(world, v);
      }
      unindexLane(world, lane);
    }
    for (const dw of link.driveways) {
      const gen = world.generators[dw.generatorId];
      if (gen) delete world.generators[gen.id];
    }
    delete world.links[id];
  }
  for (const vid of [...drop.occupants]) {
    const v = world.vehicles[vid];
    if (v) discardVehicle(world, v);
  }
  // Re-attach drop's remaining roads to keep; move drop's position onto keep.
  for (const r of Object.values(world.roads)) {
    if (r.id === road.id) continue;
    if (r.a === drop.id) {
      r.a = keep.id;
      r.points[0] = keep.pos;
    }
    if (r.b === drop.id) {
      r.b = keep.id;
      r.points[r.points.length - 1] = keep.pos;
    }
    if (r.a === keep.id || r.b === keep.id) {
      r.length = r.points.reduce((s, p, i) => (i ? s + Math.hypot(p.x - r.points[i - 1].x, p.y - r.points[i - 1].y) : 0), 0);
      for (const id of [`${r.id}>`, `${r.id}<`]) {
        const link = world.links[id];
        if (!link) continue;
        link.length = r.length;
        link.from = r.a === keep.id && id.endsWith('>') ? keep.id : link.from === drop.id ? keep.id : link.from;
        link.to = link.to === drop.id ? keep.id : link.to;
        for (const lane of [...link.lanes, link.pocketLeft, link.pocketRight].filter(Boolean) as Lane[]) if (lane.end > r.length || lane.type !== 'pocket') lane.end = lane.type === 'pocket' ? r.length : Math.min(lane.end === link.length ? r.length : lane.end, r.length);
        for (const lane of link.lanes) if (lane.type === 'general' && lane.end >= r.length - 1) lane.end = r.length;
        if (link.pocketLeft) link.pocketLeft.start = Math.max(0, r.length - (link.pocketLeft.end - link.pocketLeft.start));
        if (link.pocketRight) link.pocketRight.start = Math.max(0, r.length - (link.pocketRight.end - link.pocketRight.start));
        refreshLinkSpeed(world, link);
      }
    }
  }
  delete world.roads[road.id];
  delete world.nodes[drop.id];
  recomputeLegs(world, keep);
  refreshNodeLegs(world, keep);
  if (keep.control.signal) {
    keep.control.signal = autoPlan(keep, world, keep.control.signal);
  }
  renormaliseSignals(world, [keep.id]);
  for (const v of Object.values(world.vehicles)) if (!v.cyclic && (v.route.includes(`${road.id}>`) || v.route.includes(`${road.id}<`))) if (!rerouteVehicle(world, v)) discardVehicle(world, v);
  return ok;
}

/** Channelised right turn: a right-side slip lane with an island on the inbound link of `leg`. */
export function setSlipLane(world: World, nodeId: string, legIdx: number, on: boolean, mode: 'yield' | 'free' = 'yield', storage = SLIP_STORAGE_DEFAULT): Result {
  const node = world.nodes[nodeId];
  const leg = node?.legs.find((l) => l.leg === legIdx);
  if (!node || !leg) return fail('No such leg');
  if (!leg.inLink) return fail('No inbound traffic on that leg');
  if (node.control.type === 'roundabout') return fail('Roundabouts have no slip lanes');
  const link = world.links[leg.inLink];
  if (on) {
    if (leg.cornerRadius === 'tight') return fail('A tight corner has no room for an island');
    const exitHasRight = Object.values(node.movements).some((m) => m.fromLink === link.id && m.turn === 'R');
    if (!exitHasRight && !leg.channelisedRight) return fail('No right turn from that approach');
    if (link.pocketRight && !link.pocketRight.slip) return fail('Remove the right-turn pocket first');
    if (mode === 'free' && link.length < 80) return fail('Free-flow slip lanes need an acceleration lane; block too short');
    if (!link.pocketRight) {
      const r = setPocket(world, link, { side: 'right', storage: Math.min(storage, link.length - 40), source: 'narrow' });
      if (!r.ok) return r;
      // Slip lanes take corner land, not lane width: restore full-width through lanes.
      for (const l of generalLanes(link)) l.width = LANE_WIDTH_STANDARD;
    }
    link.pocketRight!.slip = true;
    link.pocketRight!.slipMode = mode;
    link.pocketRight!.width = LANE_WIDTH_STANDARD;
    leg.channelisedRight = true;
    leg.slipMode = mode;
  } else {
    if (!leg.channelisedRight) return ok;
    leg.channelisedRight = false;
    if (link.pocketRight?.slip) {
      const r = setPocket(world, link, { side: 'right', storage: 0, source: 'narrow' });
      if (!r.ok) return r;
    }
  }
  refreshLinkSpeed(world, link);
  refreshNodeLegs(world, node);
  renormaliseSignals(world, [node.id]);
  return ok;
}

export function setMedian(world: World, road: Road, median: Road['median']): Result {
  const before = road.median;
  road.median = median;
  if (usedWidth(world, road) > road.widthLanes) {
    road.median = before;
    return fail('No width for a median');
  }
  for (const id of [`${road.id}>`, `${road.id}<`]) {
    const link = world.links[id];
    if (!link) continue;
    refreshNodeLegs(world, world.nodes[link.to]);
  }
  return ok;
}

/** Convert a road to one-way (or back). Vehicles on the removed link are re-routed or discarded. */
export function setOneWay(world: World, road: Road, mode: Road['oneWay']): Result {
  if (mode === road.oneWay) return ok;
  const fwdId: LinkId = `${road.id}>`;
  const bwdId: LinkId = `${road.id}<`;
  const removeId = mode === 'fwd' ? bwdId : mode === 'bwd' ? fwdId : null;
  if (removeId) {
    for (const r of Object.values(world.busRoutes)) if (r.links.includes(removeId)) return fail(`Bus route ${r.id} uses that direction`);
    const link = world.links[removeId];
    if (!link) return fail('Direction already removed');
    const keep = world.links[removeId === fwdId ? bwdId : fwdId];
    // Evict vehicles.
    const lanes = [link.pocketLeft, ...link.lanes, link.pocketRight, ...link.bays].filter(Boolean) as Lane[];
    for (const lane of lanes) {
      for (const id of [...lane.vehicles]) {
        const v = world.vehicles[id];
        if (v) discardVehicle(world, v);
      }
      unindexLane(world, lane);
    }
    // Driveways move to the surviving link (mirrored position).
    for (const dw of link.driveways) {
      dw.linkId = keep.id;
      dw.pos = road.length - dw.pos;
      keep.driveways.push(dw);
      const gen = world.generators[dw.generatorId];
      if (gen) gen.drivewayLink = keep.id;
    }
    for (const s of link.busStops) {
      s.linkId = keep.id;
      s.pos = road.length - s.pos;
      keep.busStops.push(s);
    }
    for (const c of link.crossings) keep.crossings.push({ ...c, pos: road.length - c.pos });
    delete world.links[removeId];
    // All lanes to the surviving direction.
    const total = road.fwdLanes + road.bwdLanes;
    road.oneWay = mode;
    if (mode === 'fwd') {
      road.fwdLanes = total;
      road.bwdLanes = 0;
    } else {
      road.bwdLanes = total;
      road.fwdLanes = 0;
    }
    setGeneralLaneCount(world, keep, total);
    world.structureCounts['oneWay'] = (world.structureCounts['oneWay'] ?? 0) + 1;
  } else {
    // Restore two-way: split lanes evenly.
    const keep = world.links[fwdId] ?? world.links[bwdId];
    const total = generalLanes(keep).length;
    const toNew = Math.max(1, Math.floor(total / 2));
    const toKeep = Math.max(1, total - toNew);
    setGeneralLaneCount(world, keep, toKeep);
    const dir = world.links[fwdId] ? 'bwd' : 'fwd';
    createLink(world, road, dir, toNew, 'none');
    road.oneWay = 'none';
    road.fwdLanes = dir === 'fwd' ? toNew : toKeep;
    road.bwdLanes = dir === 'bwd' ? toNew : toKeep;
  }
  refreshNodeLegs(world, world.nodes[road.a]);
  refreshNodeLegs(world, world.nodes[road.b]);
  renormaliseSignals(world, [road.a, road.b]);
  // Re-route everyone whose route touches the removed link.
  for (const v of Object.values(world.vehicles)) {
    if (removeId && v.route.includes(removeId)) {
      if (!rerouteVehicle(world, v)) discardVehicle(world, v);
    }
  }
  return ok;
}

/** Add or remove a bus bay lane around a stop. */
export function setBusStopKind(world: World, stopId: string, kind: 'curbside' | 'bay'): Result {
  const stop = world.busStops[stopId];
  if (!stop) return fail('No such stop');
  const link = world.links[stop.linkId];
  const existing = link.bays.find((b) => b.start <= stop.pos && stop.pos <= b.end);
  if (kind === 'bay' && !existing) {
    if (link.parking === 'none' && generalLanes(link).length < 2) return fail('A bay needs parking or a spare lane to take width from');
    const start = Math.max(0, stop.pos - 30);
    const end = Math.min(link.length, stop.pos + 20);
    const lane = makeLane(link.id, link.bays.length, 'bay', start, end, []);
    indexLane(world, lane);
    link.bays.push(lane);
  } else if (kind === 'curbside' && existing) {
    const right = generalLanes(link)[generalLanes(link).length - 1];
    mergeLaneInto(world, existing, right);
    unindexLane(world, existing);
    link.bays.splice(link.bays.indexOf(existing), 1);
  }
  stop.kind = kind;
  return ok;
}

/** Apply lane-drop placement for a node leg: aux merge lane after the node, or an early merge before it. */
export function applyLaneDrops(world: World, nodeId: string): void {
  const node = world.nodes[nodeId];
  for (const leg of node.legs) {
    if (!leg.outLink) continue;
    const out = world.links[leg.outLink];
    const opposite = node.legs.find((l) => l.leg === ((leg.leg + 2) % 4));
    if (!opposite?.inLink) continue;
    const inLink = world.links[opposite.inLink];
    const throughLanes = generalLanes(inLink).filter((l) => l.allowed.includes('T')).length;
    const outGeneral = generalLanes(out);
    const aux = out.lanes.find((l) => l.type === 'general' && l.end < out.length - 1 && l.start === 0);
    const inRight = generalLanes(inLink)[generalLanes(inLink).length - 1];
    if (throughLanes > outGeneral.filter((l) => l.end >= out.length - 1).length && leg.laneDrop === 'after' && !aux) {
      const lane = makeLane(out.id, out.lanes.length, 'general', 0, Math.min(70, out.length - 30), []);
      const insertAt = out.lanes.indexOf(outGeneral[outGeneral.length - 1]) + 1;
      out.lanes.splice(insertAt, 0, lane);
      indexLane(world, lane);
      renumberLanes(world, out);
      if (inRight) inRight.end = inLink.length;
    } else if (leg.laneDrop === 'before') {
      if (aux) {
        mergeLaneInto(world, aux, outGeneral[outGeneral.length - 1]);
        unindexLane(world, aux);
        out.lanes.splice(out.lanes.indexOf(aux), 1);
        renumberLanes(world, out);
      }
      if (throughLanes > outGeneral.length && inRight && generalLanes(inLink).length > 1) inRight.end = inLink.length - 60;
    } else if (aux && throughLanes <= outGeneral.length - 1) {
      mergeLaneInto(world, aux, outGeneral[outGeneral.length - 1]);
      unindexLane(world, aux);
      out.lanes.splice(out.lanes.indexOf(aux), 1);
      renumberLanes(world, out);
    }
  }
}
