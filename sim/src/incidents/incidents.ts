/** Conflict scoring, crashes and other lane-blocking incidents. */
import { chance, nextRange, pick, poissonEvent } from '../core/rng.js';
import type { Incident, IncidentKind, Lane, SimNode, World } from '../model/types.js';
import { lanesAllowing } from '../network/lanes.js';
import { conflictBetween } from '../network/geometry.js';
import { pedRateAtNode } from '../traffic/pedestrians.js';
import { clearanceDeficit } from '../control/signal.js';
import { sightPenalty } from '../control/manager.js';

/** Are two conflicting movements fully separated by the signal (never green together, no permitted)? */
function signalSeparates(node: SimNode, a: string, b: string): boolean {
  const plan = node.control.signal;
  if (!plan) return false;
  for (const p of plan.phases) if (p.movements.includes(a) && p.movements.includes(b)) return false;
  return true;
}

/** Conflict score: exposure-weighted conflicts that the control does not resolve. */
export function conflictScore(world: World, node: SimNode): { score: number; worst: string } {
  const d = node.metrics.demand;
  let score = 0;
  let worst = '';
  let worstVal = 0;
  const keys = Object.keys(node.movements);
  const signal = node.control.type === 'signal' && node.control.signal && !node.control.runtime?.malfunction;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i];
      const b = keys[j];
      const k = conflictBetween(node, a, b);
      if (k !== 'cross' && k !== 'merge') continue;
      if (signal && signalSeparates(node, a, b)) continue;
      const fa = d[a] ?? 0;
      const fb = d[b] ?? 0;
      let val = (fa * fb) / 1e5;
      if (k === 'merge') val *= 0.3;
      if (node.control.type === 'roundabout') val *= 0.35;
      if (node.control.type === 'all-way-stop') val *= 0.3;
      if (val > worstVal) {
        worstVal = val;
        worst = `${a} × ${b}`;
      }
      score += val;
    }
  }
  // Pedestrian conflicts with turning vehicles.
  const pedRate = pedRateAtNode(world, node);
  for (const k of keys) {
    const m = node.movements[k];
    if (m.turn === 'T') continue;
    const p = node.peds[`ped:${m.exitLeg}`];
    if (!p?.enabled) continue;
    const leg = node.legs.find((l) => l.leg === m.entryLeg);
    const factor = node.control.signal?.pedTreatment === 'exclusive' || node.control.signal?.pedTreatment === 'scramble' ? 0.1 : node.control.signal?.pedTreatment === 'lpi' ? 0.5 : 1;
    score += ((d[k] ?? 0) * (pedRate / Math.max(1, node.legs.length))) / 3e5 * factor * (leg?.channelisedRight && m.turn === 'R' ? 0.3 : 1);
  }
  // Geometry: skew and restricted sight make every unresolved conflict worse.
  const geometryFactor = 1 + node.skew / 60 + node.legs.reduce((s, l) => s + (l.inLink ? sightPenalty(world, l.inLink) / 3 : 0), 0);
  score *= geometryFactor;
  // Short clearance: each second stolen from yellow/all-red is red-light running exposure on every approach.
  if (signal) score += clearanceDeficit(node, world) * 0.4 * node.legs.filter((l) => l.inLink).length;
  // Driveways near the node and dilemma-zone exposure.
  for (const leg of node.legs) {
    if (!leg.inLink) continue;
    const link = world.links[leg.inLink];
    for (const dw of link.driveways) if (link.length - dw.pos < 60) score += 0.05;
    if (signal && link.speedLimit >= 13) {
      const plan = node.control.signal!;
      const hasAdvance = plan.detectors.some((det) => det.setback > 40 && world.lanes[det.laneId]?.linkId === link.id);
      if (!hasAdvance) score += plan.actuated ? 0.08 : 0.12;
    }
  }
  return { score, worst };
}

export function refreshConflictScores(world: World): void {
  for (const node of Object.values(world.nodes)) node.metrics.conflictScore = conflictScore(world, node).score;
}

function blockLane(world: World, lane: Lane, pos: number, kind: IncidentKind, until: number, cause: string, nodeId: string | null = null): Incident {
  const inc: Incident = { id: world.nextIncidentId++, kind, laneId: lane.id, nodeId, pos, until, cause };
  lane.blockedAt = lane.blockedAt === null ? pos : Math.min(lane.blockedAt, pos);
  world.incidents.push(inc);
  return inc;
}

/** Roll for crashes and other incidents. Called every tick with dt. */
export function rollIncidents(world: World, dt: number): void {
  const scale = world.config.crashRateScale;
  for (const node of Object.values(world.nodes)) {
    const sc = node.metrics.conflictScore;
    if (sc <= 0) continue;
    const ratePerSec = (0.08 * sc * scale) / 3600;
    if (!poissonEvent(world.rng, ratePerSec, dt)) continue;
    const { worst } = conflictScore(world, node);
    const severe = chance(world.rng, 0.12);
    node.metrics.crashes++;
    world.metrics.crashes++;
    const mkey = worst.split(' × ')[0];
    const m = node.movements[mkey];
    if (severe) {
      // Block the whole node: every inbound lane blocked at the stop line. Severe crashes scar the pavement.
      const until = world.t + nextRange(world.rng, 20, 40) * 60;
      for (const leg of node.legs) {
        if (!leg.inLink) continue;
        const link = world.links[leg.inLink];
        link.wear = Math.min(1, link.wear + 0.05);
        for (const lane of link.lanes) if (lane.type !== 'parking') blockLane(world, lane, link.length - 2, 'severe-crash', until, worst, node.id);
      }
    } else if (m) {
      const link = world.links[m.fromLink];
      const lanes = lanesAllowing(link, m.turn);
      const lane = lanes.length ? pick(world.rng, lanes) : link.lanes[0];
      blockLane(world, lane, Math.max(lane.start + 5, link.length - nextRange(world.rng, 5, 40)), 'crash', world.t + nextRange(world.rng, 10, 25) * 60, worst, node.id);
    }
  }
  // Segment incidents: stalls, double parking, parking manoeuvres.
  for (const link of Object.values(world.links)) {
    const general = link.lanes.filter((l) => l.type === 'general');
    if (!general.length) continue;
    const right = general[general.length - 1];
    // Double-parked delivery trucks near shops without a loading zone.
    if (!link.loadingZone) {
      for (const dw of link.driveways) {
        const g = world.generators[dw.generatorId];
        if (!g?.active || g.kind !== 'shop') continue;
        if (poissonEvent(world.rng, (0.5 * world.demandMultiplier) / 3600, dt)) blockLane(world, right, dw.pos - 8, 'double-parked', world.t + nextRange(world.rng, 120, 300), `delivery at ${g.id}`);
      }
    }
    // Parking manoeuvre friction.
    if (link.parking === 'always' || link.parking === 'peak-ban') {
      const rate = (link.length / 100) * 0.6 * world.demandMultiplier / 3600;
      if (poissonEvent(world.rng, rate, dt)) blockLane(world, right, nextRange(world.rng, 10, Math.max(11, link.length - 20)), 'parking-manoeuvre', world.t + nextRange(world.rng, 3, 6), 'parking');
    }
    // Random stall.
    const veh = general.reduce((s, l) => s + l.vehicles.length, 0);
    if (veh && poissonEvent(world.rng, (veh * 0.002 * (1 + 4 * link.wear)) / 3600, dt)) {
      const lane = pick(world.rng, general);
      blockLane(world, lane, nextRange(world.rng, 10, Math.max(11, link.length - 10)), 'stall', world.t + nextRange(world.rng, 180, 600), 'stalled vehicle');
    }
  }
  // Signal malfunction.
  for (const node of Object.values(world.nodes)) {
    if (node.control.type !== 'signal' || !node.control.runtime || node.control.runtime.malfunction) continue;
    if (poissonEvent(world.rng, 0.01 / world.config.dayLength, dt)) {
      node.control.runtime.malfunction = true;
      // Flashing red until the player resets it, or a technician arrives after 20 minutes.
      world.incidents.push({ id: world.nextIncidentId++, kind: 'signal-malfunction', laneId: null, nodeId: node.id, pos: 0, until: world.t + 1200, cause: 'controller fault' });
    }
  }
}

/** Clear expired incidents and recompute lane blockages. */
export function expireIncidents(world: World): void {
  const before = world.incidents.length;
  const expired = world.incidents.filter((i) => i.until <= world.t);
  if (!expired.length) return;
  world.incidents = world.incidents.filter((i) => i.until > world.t);
  for (const i of expired) {
    if (i.kind === 'signal-malfunction' && i.nodeId) {
      const rt = world.nodes[i.nodeId]?.control.runtime;
      if (rt) rt.malfunction = false;
    }
  }
  if (world.incidents.length !== before) recomputeBlockages(world);
}

/** Lane.blockedAt is the min over active incidents and constructions on that lane. */
export function recomputeBlockages(world: World): void {
  for (const lane of Object.values(world.lanes)) lane.blockedAt = null;
  for (const i of world.incidents) {
    if (!i.laneId) continue;
    const lane = world.lanes[i.laneId];
    if (lane) lane.blockedAt = lane.blockedAt === null ? i.pos : Math.min(lane.blockedAt, i.pos);
  }
  for (const c of world.constructions) {
    if (!c.laneId) continue;
    const lane = world.lanes[c.laneId];
    if (lane) lane.blockedAt = lane.blockedAt === null ? lane.end - 5 : Math.min(lane.blockedAt, lane.end - 5);
  }
  for (const e of world.events) {
    if (!e.applied || e.end <= world.t) continue;
    for (const id of e.closedLanes) {
      const lane = world.lanes[id];
      if (lane) lane.blockedAt = lane.blockedAt === null ? lane.start + 2 : Math.min(lane.blockedAt, lane.start + 2);
    }
  }
}

export function resetSignalMalfunction(world: World, nodeId: string): boolean {
  const node = world.nodes[nodeId];
  if (!node?.control.runtime?.malfunction) return false;
  node.control.runtime.malfunction = false;
  world.incidents = world.incidents.filter((i) => !(i.kind === 'signal-malfunction' && i.nodeId === nodeId));
  return true;
}
