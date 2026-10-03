/**
 * Per-tick vehicle dynamics: car-following, lane changing, pockets, stop lines,
 * node traversal with box blocking, bus stops, driveway arrivals and median crossovers.
 */
import { chance } from '../core/rng.js';
import { clamp, removeFromArray } from '../core/util.js';
import type { Lane, Link, Movement, SimNode, Vehicle, World } from '../model/types.js';
import { allTrafficLanes, neighbourLane } from '../network/lanes.js';
import { approachingVehicles, cfiCrossingOpen, destinationLane, mayEnter, viewFor, type Approaching, type EntryDecision } from '../control/manager.js';
import type { SignalView } from '../control/signal.js';
import { destinationLinks, rerouteVehicle, shortestPath } from '../routing/routing.js';
import {
  addToLane,
  currentLink,
  destinationIsLeftIn,
  isCrossoverNext,
  lastVehicleIn,
  leaderInLane,
  neighboursAt,
  nextMovement,
  params,
  posOf,
  removeFromLane,
  requiredLanes,
  resortLane,
  vehicleLength,
} from './access.js';
import { idmAccel, idmFree } from './idm.js';
import { finishTrip } from './trips.js';

interface NodeCache {
  approaching: Approaching[];
  sig: SignalView | null;
}

const STOP_LINE_ZONE = 4;

interface Obstacle {
  gap: number;
  dv: number;
}

function nearer(a: Obstacle | null, b: Obstacle | null): Obstacle | null {
  if (!a) return b;
  if (!b) return a;
  return a.gap <= b.gap ? a : b;
}

function staticObstacle(pos: number, at: number, v: Vehicle): Obstacle {
  return { gap: at - pos, dv: v.speed };
}

/** Obstacle that makes the vehicle's front come to rest at `target` (IDM keeps minGap behind an obstacle). */
function stopAt(pos: number, target: number, v: Vehicle): Obstacle {
  return { gap: target - pos + params(v).minGap + 0.3, dv: v.speed };
}
const ARRIVE_TOL = 2.5;

export function stepVehicles(world: World, dt: number): void {
  const cache = new Map<string, NodeCache>();
  const nodeCache = (node: SimNode): NodeCache => {
    let c = cache.get(node.id);
    if (!c) {
      c = { approaching: approachingVehicles(world, node), sig: viewFor(node, world) };
      cache.set(node.id, c);
    }
    return c;
  };

  // Snapshot ids: vehicles may be removed during the step.
  const ids = Object.keys(world.vehicles).map(Number);
  for (const id of ids) {
    const v = world.vehicles[id];
    if (!v) continue;
    if (v.place.kind === 'lane') stepOnLane(world, v, dt, nodeCache);
    else if (v.place.kind === 'node') stepInNode(world, v, dt);
  }
  // Keep lane orderings consistent after moves.
  for (const lane of Object.values(world.lanes)) if (lane.vehicles.length > 1) resortLane(world, lane);
}

// ───────────────────────────── on a lane ─────────────────────────────

function stepOnLane(world: World, v: Vehicle, dt: number, nodeCache: (n: SimNode) => NodeCache): void {
  if (v.place.kind !== 'lane') return;
  let lane = world.lanes[v.place.laneId];
  if (!lane) return;
  const link = world.links[lane.linkId];
  const p = params(v);

  // Bus dwelling at a stop.
  if (v.dwelling) {
    if (world.t >= v.dwellUntil) v.dwelling = false;
    else {
      v.speed = 0;
      return;
    }
  }

  // Lane changing may move the vehicle to a neighbouring lane.
  const changed = laneChange(world, v, lane, link, dt);
  if (changed) lane = changed;
  const pos = (v.place as { pos: number }).pos;

  const m = nextMovement(world, v);
  const crossoverNext = isCrossoverNext(world, v);
  const node = world.nodes[link.to];
  const required = requiredLanes(world, v, link.id);
  const inRequired = required.includes(lane);

  // Desired speed
  let v0 = link.speedLimit * p.desiredSpeedFactor * (1 - 0.3 * link.wear);
  if (m && m.turn !== 'T' && link.length - pos < 40) v0 = Math.min(v0, m.speed + 3);
  // Nobody drives through an uncontrolled crossing at speed: approach at a cautious crawl.
  if (m && node.control.type === 'uncontrolled' && node.legs.length >= 3 && link.length - pos < 30) v0 = Math.min(v0, 5);
  if (lane.width < 3.2) v0 *= 0.92;

  // ── Obstacles ──
  let obs: Obstacle | null = null;
  const leader = leaderInLane(world, lane, v);
  if (leader) obs = { gap: posOf(world, leader.id) - vehicleLength(leader) - pos, dv: v.speed - leader.speed };

  if (lane.blockedAt !== null && lane.blockedAt > pos - 1) obs = nearer(obs, staticObstacle(pos, lane.blockedAt - 1.5, v));

  // Lane ends before the stop line (lane drop / bay / blocked): must have changed by then.
  if (lane.end < link.length - 0.5 && !inRequiredOrContinuing(lane, required, link)) obs = nearer(obs, staticObstacle(pos, lane.end - 2, v));
  if (lane.end < link.length - 0.5 && inRequired === false && required.length === 0) obs = nearer(obs, staticObstacle(pos, lane.end - 2, v));

  // Mid-block crossing active ahead.
  for (const c of crossingsOnLink(world, link)) {
    if (c.activeUntil > world.t && c.pos > pos && c.pos - pos < 60) obs = nearer(obs, staticObstacle(pos, c.pos - 2, v));
  }

  // Bus: next stop on this link.
  const stop = busStopAhead(world, v, link, lane);
  if (stop) {
    if (pos >= stop.pos - ARRIVE_TOL && v.speed < 0.6) {
      beginDwell(world, v, stop.pos);
      return;
    }
    obs = nearer(obs, stopAt(pos, stop.pos, v));
  }

  // Waiting to enter a pocket that is full: stop beside its tail.
  const pocketWait = pocketTailObstacle(world, v, lane, link, required, pos);
  if (pocketWait) obs = nearer(obs, pocketWait);

  // CFI pre-signal: lefts wait at the crossover until the main signal lets them cross the opposing lanes.
  const cfiBay = required.find((l) => l.cfi);
  if (cfiBay && lane !== cfiBay && pos >= cfiBay.start - 60 && !cfiCrossingOpen(world, link.id)) obs = nearer(obs, stopAt(pos, cfiBay.start - 1, v));
  // Departing traffic is held at the crossover while lefts are crossing in front of it.
  const hold = cfiHoldPosition(world, link);
  if (hold !== null && pos < hold - 0.5) obs = nearer(obs, stopAt(pos, hold - 1, v));

  // Destination on this link.
  let arriving = false;
  if (!m && !crossoverNext && v.destPos !== null) {
    arriving = true;
    const leftIn = destinationIsLeftIn(world, v);
    if (pos >= v.destPos - ARRIVE_TOL) {
      if (!leftIn) {
        // Right-in: turn in once slow enough.
        if (v.speed < 4) {
          finishTrip(world, v);
          return;
        }
      } else if (tryLeftIn(world, v, lane, link, dt)) return;
      obs = nearer(obs, stopAt(pos, v.destPos, v));
    } else {
      // Slow toward the driveway; right-in only needs ~3 m/s, left-in must stop.
      obs = nearer(obs, leftIn ? stopAt(pos, v.destPos, v) : { gap: v.destPos - pos + 4, dv: v.speed - 3 });
    }
  }

  // Median crossover U-turn.
  if (crossoverNext) {
    const xo = crossoverFor(world, v, link);
    if (xo) {
      const xpos = link.id.endsWith('>') ? xo.pos : link.length - xo.pos;
      if (pos >= xpos - ARRIVE_TOL) {
        if (tryCrossover(world, v, lane, link, xo, xpos)) return;
        obs = nearer(obs, stopAt(pos, xpos, v));
      } else obs = nearer(obs, stopAt(pos, xpos, v));
    }
  }

  // Stop line.
  let decision: EntryDecision | null = null;
  const nearLine = link.length - pos < STOP_LINE_ZONE + 1;
  if (m && !leader) {
    const nc = nodeCache(node);
    if (!inRequired && !v.improvising) {
      // Wrong lane at the end: cannot enter. Stay put and drain patience.
      decision = { go: false, reason: 'wrong-lane', mustStop: false };
    } else {
      decision = mayEnter(world, node, v, m, nc.approaching, nc.sig);
    }
    if (!decision.go) {
      obs = nearer(obs, staticObstacle(pos, link.length, v));
    } else {
      // Follow the vehicle ahead through the node (same movement or merging).
      const ahead = occupantAhead(world, node, m) ?? decision.mergeLeader;
      if (ahead && ahead.place.kind === 'node') {
        obs = nearer(obs, { gap: link.length - pos + ahead.place.pos - vehicleLength(ahead), dv: v.speed - ahead.speed });
      }
    }
  } else if (m && leader) {
    // A leader at the stop line with a stop decision is already an obstacle.
  }
  if (!m && !crossoverNext && !arriving) {
    // No way forward from this link (route broken by an edit, or an invalid hop): stop at the end and re-route.
    obs = nearer(obs, staticObstacle(pos, link.length, v));
    if (!v.cyclic && world.t >= v.nextReroute) {
      v.nextReroute = world.t + 10;
      if (!rerouteVehicle(world, v)) improvise(world, v, lane, link);
    }
  }
  // Approaching node when ending on a different leg of the *same* link but lane disallows (handled above).

  // ── Integrate ──
  const acc = obs ? idmAccel(p, v.speed, v0, obs.gap, obs.dv) : idmFree(p, v.speed, v0);
  v.accel = acc;
  v.speed = Math.max(0, v.speed + acc * dt);
  let newPos = pos + v.speed * dt;

  // Stop-line bookkeeping.
  if (nearLine) {
    if (v.stopLineArrival === 0) v.stopLineArrival = world.t;
    if (v.speed < 0.3) {
      v.stoppedFor += dt;
      if (v.stoppedFor >= 0.7) v.hasStopped = true;
    }
  }
  // Delay and patience.
  const slow = v.speed < 0.5 * v0;
  if (slow) v.delay += dt * (1 - v.speed / Math.max(v0, 0.1));
  if (link.length - pos < 150) v.approachDelay += dt * Math.max(0, 1 - v.speed / Math.max(v0, 0.1));
  if (v.speed < 1) v.patience = clamp(v.patience - world.config.patienceDrainPerSec * dt, 0, 1);
  else v.patience = clamp(v.patience + world.config.patienceRecoverPerSec * dt, 0, 1);

  // Improvise: stuck in the wrong lane with no patience → take whatever turn this lane allows.
  if (v.speed < 0.3 && m && !inRequired && !v.cyclic && (v.patience < world.config.improviseBelow || (lane.allowed.length === 0 && nearLine))) {
    improvise(world, v, lane, link);
  }

  // Enter the node?
  if (m && decision?.go && newPos >= link.length) {
    enterNode(world, v, lane, link, node, m, newPos - link.length);
    return;
  }
  if (newPos > link.length) {
    newPos = link.length;
    v.speed = 0;
  }
  (v.place as { pos: number }).pos = newPos;
}

/** On a link departing a CFI node: the position of the pre-signal if it is currently red for departing traffic. */
function cfiHoldPosition(world: World, link: Link): number | null {
  const road = world.roads[link.roadId];
  if (!road.crossovers.length) return null;
  for (const xo of road.crossovers) {
    if (xo.kind !== 'cfi-presignal' || !xo.approachLink || xo.approachLink === link.id) continue;
    if (world.links[xo.approachLink]?.roadId !== link.roadId) continue;
    // This link is the reverse of the approach; lefts cross it at the crossover.
    if (cfiCrossingOpen(world, xo.approachLink)) return link.id.endsWith('>') ? xo.pos : road.length - xo.pos;
  }
  return null;
}

function inRequiredOrContinuing(lane: Lane, required: Lane[], link: Link): boolean {
  if (required.includes(lane)) return lane.end >= link.length - 0.5;
  return false;
}

function crossingsOnLink(world: World, link: Link) {
  // Crossings are stored on the forward link but apply to both directions.
  const road = world.roads[link.roadId];
  const fwd = world.links[`${road.id}>`];
  const list = fwd?.crossings ?? link.crossings;
  if (link.id.endsWith('>')) return list;
  return list.map((c) => ({ ...c, pos: road.length - c.pos }));
}

/** Vehicles already inside the node on the same movement; returns the one closest behind the stop line. */
function occupantAhead(world: World, node: SimNode, m: Movement): Vehicle | null {
  let best: Vehicle | null = null;
  for (const id of node.occupants) {
    const o = world.vehicles[id];
    if (o.place.kind !== 'node' || o.place.movement !== m.key) continue;
    if (!best || o.place.pos < (best.place as { pos: number }).pos) best = o;
  }
  return best;
}

function pocketTailObstacle(world: World, v: Vehicle, lane: Lane, link: Link, required: Lane[], pos: number): Obstacle | null {
  if (required.includes(lane)) return null;
  const pocket = required.find((l) => l.type === 'pocket');
  if (!pocket) return null;
  // Only the lane adjacent to the pocket can wait for it.
  const adj = neighbourLane(link, pocket, pocket.index < 0 ? 1 : -1);
  if (adj !== lane) return null;
  if (pos < pocket.start - 8) return null;
  const last = lastVehicleIn(world, pocket);
  const room = last ? posOf(world, last.id) - vehicleLength(last) - pocket.start : pocket.end - pocket.start;
  if (room >= vehicleLength(v) + 1.5) return null; // can enter: handled by lane change
  const tail = last ? posOf(world, last.id) - vehicleLength(last) : pocket.start;
  return { gap: Math.max(0.1, tail - pos - 0.5), dv: v.speed };
}

// ───────────────────────────── lane changing ─────────────────────────────

function laneChange(world: World, v: Vehicle, lane: Lane, link: Link, dt: number): Lane | null {
  if (v.place.kind !== 'lane') return null;
  const pos = v.place.pos;
  const p = params(v);
  if (world.t - v.lastLaneChangeT < 1.5) return null;
  const required = requiredLanes(world, v, link.id);
  const remaining = link.length - pos;

  // Mandatory: not in a required lane, or lane ends.
  const laneEnds = lane.end < link.length - 0.5 && pos > lane.end - 80;
  const mandatory = (!required.includes(lane) && required.length > 0) || laneEnds;
  let target: Lane | null = null;
  if (mandatory) {
    if (required.length) {
      // Nearest required lane by index.
      let best = required[0];
      for (const r of required) if (Math.abs(r.index - lane.index) < Math.abs(best.index - lane.index)) best = r;
      target = best;
    } else {
      // Nowhere valid: move toward any general lane that continues.
      const cont = allTrafficLanes(link).filter((l) => l.type !== 'bay' && l.end >= link.length - 0.5 && l !== lane);
      target = cont[0] ?? null;
    }
    if (target && target !== lane) {
      const dir: -1 | 1 = target.index < lane.index ? -1 : 1;
      const step = neighbourLane(link, lane, dir);
      if (!step) return null;
      if (step.type === 'pocket' && pos < step.start) return null; // pocket not reachable yet
      if (step.cfi && !cfiCrossingOpen(world, link.id)) return null; // pre-signal red
      if (step.type === 'bus' && v.cls !== 'bus' && v.cls !== 'emergency' && step.protectedBus) return null;
      if (pos < step.start || pos > step.end) return null;
      const urgency = clamp(1 - (laneEnds ? lane.end - pos : remaining - 20) / 100, 0, 1);
      if (safeToChange(world, v, step, pos, urgency)) return doChange(world, v, lane, step, pos);
      return null;
    }
    return null;
  }

  // Discretionary: balance lanes among those allowing the same turn.
  if (v.cls === 'bus') return null;
  const leader = leaderInLane(world, lane, v);
  const myGap = leader ? posOf(world, leader.id) - vehicleLength(leader) - pos : Infinity;
  if (myGap > 25 || v.speed > 0.7 * link.speedLimit) return null;
  if (!chance(world.rng, 0.4 * dt)) return null;
  for (const dir of [-1, 1] as const) {
    const n = neighbourLane(link, lane, dir);
    if (!n || n.type === 'pocket' || n.type === 'parking' || !required.includes(n)) continue;
    if (n.end < link.length - 0.5 || pos < n.start) continue;
    if (n.type === 'bus') continue;
    const { ahead } = neighboursAt(world, n, pos, v.id);
    const gap = ahead ? posOf(world, ahead.id) - vehicleLength(ahead) - pos : Infinity;
    if (gap > myGap + 15 && safeToChange(world, v, n, pos, 0)) return doChange(world, v, lane, n, pos);
  }
  return null;
}

function safeToChange(world: World, v: Vehicle, target: Lane, pos: number, urgency: number): boolean {
  const p = params(v);
  const { ahead, behind } = neighboursAt(world, target, pos, v.id);
  const len = vehicleLength(v);
  const minAhead = p.minGap + (1 - urgency) * v.speed * 0.8;
  const minBehind = p.minGap + (1 - urgency) * (behind?.speed ?? 0) * 1.0;
  if (ahead && posOf(world, ahead.id) - vehicleLength(ahead) - pos < minAhead) return false;
  if (behind && pos - len - posOf(world, behind.id) < minBehind) return false;
  if (target.blockedAt !== null && target.blockedAt > pos && target.blockedAt - pos < 15) return false;
  return true;
}

function doChange(world: World, v: Vehicle, from: Lane, to: Lane, pos: number): Lane {
  removeFromLane(world, from, v);
  addToLane(world, to, v, pos);
  v.lastLaneChangeT = world.t;
  // Entering a pocket counts as being on it; leaving the required lane resets improvising.
  return to;
}

/** Driver gives up on the required lane and takes a turn the current lane allows, re-routing after it. */
function improvise(world: World, v: Vehicle, lane: Lane, link: Link): void {
  const node = world.nodes[link.to];
  const options = Object.values(node.movements).filter((m) => m.fromLink === link.id && (lane.allowed.length === 0 || lane.allowed.includes(m.turn)) && !node.banned.includes(m.key));
  if (!options.length) return;
  const m = options[0];
  v.improvising = true;
  v.patience = 0.5;
  // Complete the route from the new link; if impossible, keep the two-link route and retry later.
  const dests = v.destGen ? destinationLinks(world, v.destGen) : [];
  const rest = dests.length ? shortestPath(world, m.toLink, { cls: v.cls, destLinks: dests, originFraction: 0 }) : null;
  v.route = rest ? [link.id, ...rest] : [link.id, m.toLink];
  v.routeIdx = 0;
  if (rest && v.destGen) {
    const gen = world.generators[v.destGen];
    const dw = world.links[gen.drivewayLink].driveways.find((d) => d.generatorId === gen.id);
    const last = v.route[v.route.length - 1];
    if (dw) v.destPos = last === gen.drivewayLink ? dw.pos : world.links[last].length - dw.pos;
  }
}

// ───────────────────────────── node traversal ─────────────────────────────

function enterNode(world: World, v: Vehicle, lane: Lane, link: Link, node: SimNode, m: Movement, overshoot: number): void {
  // Lane permission violation (improvising or non-compliance).
  if (!lane.allowed.includes(m.turn)) v.violations += 1;
  removeFromLane(world, lane, v);
  v.place = { kind: 'node', nodeId: node.id, movement: m.key, pos: Math.max(0, overshoot) };
  node.occupants.push(v.id);
  v.nodeEnterTime = world.t;
  // Pavement wear: heavy vehicles do the damage (fourth-power law, roughly).
  const axle = v.cls === 'truck' ? 8 : v.cls === 'bus' ? 4 : 1;
  link.wear = Math.min(1, link.wear + world.config.wearPerCarKm * axle * (link.length / 1000));
  // Travel time sample for routing.
  const sample = world.t - v.linkEnterT;
  if (sample > 0 && sample < 3600) link.travelTime = link.travelTime + 0.2 * (sample - link.travelTime);
  const linkDelay = Math.max(0, sample - link.freeFlowTime);
  world.metrics.linkDelay[link.id] = (world.metrics.linkDelay[link.id] ?? 0) * 0.8 + 0.2 * linkDelay;
  // Node metrics.
  const nm = node.metrics;
  nm.delayAccum += v.approachDelay;
  nm.served += 1;
  nm.tmcWindow[m.key] = (nm.tmcWindow[m.key] ?? 0) + 1;
  v.approachDelay = 0;
  v.hasStopped = false;
  v.stoppedFor = 0;
  v.stopLineArrival = 0;
  v.improvising = false;
  removeFromArray(node.stopQueue, v.id);
}

function stepInNode(world: World, v: Vehicle, dt: number): void {
  if (v.place.kind !== 'node') return;
  const node = world.nodes[v.place.nodeId];
  const m = node?.movements[v.place.movement];
  if (!node || !m) {
    // Node or movement vanished under an edit: drop the vehicle onto its destination link start if possible.
    const next = v.route[v.routeIdx + 1];
    const dest = next ? world.links[next] : null;
    if (dest) {
      removeFromArray(node?.occupants ?? [], v.id);
      v.routeIdx += 1;
      const lane = dest.lanes.find((l) => l.type === 'general') ?? dest.lanes[0];
      addToLane(world, lane, v, 0);
      v.linkEnterT = world.t;
    } else finishTrip(world, v);
    return;
  }
  const p = params(v);
  const pos = v.place.pos;
  const dest = destinationLane(world, v, m);
  let obs: Obstacle | null = null;
  // Leader on the same movement.
  for (const id of node.occupants) {
    if (id === v.id) continue;
    const o = world.vehicles[id];
    if (o.place.kind !== 'node') continue;
    if (o.place.movement !== m.key && node.conflicts[m.key]?.[o.place.movement] !== 'merge') continue;
    if (o.place.pos > pos) obs = nearer(obs, { gap: o.place.pos - vehicleLength(o) - pos, dv: v.speed - o.speed });
  }
  // Destination lane tail.
  let exitBlocked = false;
  if (dest) {
    const last = lastVehicleIn(world, dest);
    if (last) {
      const rear = posOf(world, last.id) - vehicleLength(last) - dest.start;
      const gap = m.length - pos + rear;
      obs = nearer(obs, { gap, dv: v.speed - last.speed });
      if (rear < vehicleLength(v) + 1.0) exitBlocked = true;
    }
    if (dest.blockedAt !== null && dest.blockedAt < 8) exitBlocked = true;
  } else exitBlocked = true;
  if (exitBlocked) obs = nearer(obs, staticObstacle(pos, m.length, v));

  const acc = obs ? idmAccel(p, v.speed, m.speed, obs.gap, obs.dv) : idmFree(p, v.speed, m.speed);
  v.speed = Math.max(0, v.speed + acc * dt);
  let newPos = pos + v.speed * dt;
  if (v.speed < 0.5) v.delay += dt;
  if (v.speed < 1) v.patience = clamp(v.patience - world.config.patienceDrainPerSec * dt, 0, 1);

  if (newPos >= m.length) {
    if (exitBlocked || !dest) {
      v.place.pos = m.length;
      v.speed = 0;
      return; // box blocked
    }
    removeFromArray(node.occupants, v.id);
    if (v.cyclic && v.routeIdx + 1 >= v.route.length) v.routeIdx = 0;
    else v.routeIdx += 1;
    v.linkEnterT = world.t;
    addToLane(world, dest, v, Math.min(newPos - m.length, Math.max(0, dest.end - 1)));
    // Periodic re-routing on entering a link.
    if (!v.cyclic && world.t >= v.nextReroute) {
      v.nextReroute = world.t + world.config.rerouteInterval;
      if (chance(world.rng, world.config.rerouteShare)) rerouteVehicle(world, v);
    }
    // Variable message sign at this node.
    if (node.vms && chance(world.rng, node.vms.compliance) && !v.cyclic) rerouteVehicle(world, v, { link: node.vms.avoidLink, mult: node.vms.multiplier });
    return;
  }
  v.place.pos = newPos;
}

// ───────────────────────────── buses ─────────────────────────────

function busStopAhead(world: World, v: Vehicle, link: Link, lane: Lane): { pos: number } | null {
  if (v.cls !== 'bus' || !v.busRoute) return null;
  const route = world.busRoutes[v.busRoute];
  if (!route) return null;
  const stopId = route.stops[v.busStopIdx % route.stops.length];
  const stop = world.busStops[stopId];
  if (!stop || stop.linkId !== link.id) return null;
  const pos = (v.place as { pos: number }).pos;
  if (pos > stop.pos + 1) return null;
  if (stop.kind === 'bay') {
    // Must be in the bay lane to stop; requiredLanes steers the bus into it.
    const bay = bayForStop(link, stop.pos);
    if (bay && lane !== bay) return null;
  } else {
    // Curbside: rightmost drivable lane.
    const drivable = link.lanes.filter((l) => l.type === 'general' || l.type === 'bus');
    if (lane !== drivable[drivable.length - 1]) return null;
  }
  return { pos: stop.pos };
}

export function bayForStop(link: Link, stopPos: number): Lane | null {
  return link.bays.find((b) => b.start <= stopPos && stopPos <= b.end) ?? null;
}

function beginDwell(world: World, v: Vehicle, _stopPos: number): void {
  if (!v.busRoute) return;
  const route = world.busRoutes[v.busRoute];
  const stop = world.busStops[route.stops[v.busStopIdx % route.stops.length]];
  const waiting = stop.waiting[route.id] ?? 0;
  const alight = Math.round(v.people * 0.35);
  const board = Math.min(waiting, 60 - (v.people - alight));
  stop.waiting[route.id] = waiting - board;
  // People alighting complete their trip.
  if (alight > 0) {
    world.metrics.peopleMoved += alight;
    world.metrics.tripsCompleted += alight;
    world.metrics.score += alight * 8;
  }
  v.people = v.people - alight + board;
  v.dwelling = true;
  v.dwellUntil = world.t + 6 + 1.5 * board + 1.0 * alight;
  v.busStopIdx = (v.busStopIdx + 1) % Math.max(1, route.stops.length);
}

// ───────────────────────────── driveways: left-in ─────────────────────────────

function tryLeftIn(world: World, v: Vehicle, lane: Lane, link: Link, dt: number): boolean {
  const road = world.roads[link.roadId];
  const rev = world.links[link.id.endsWith('>') ? `${road.id}<` : `${road.id}>`];
  const crossPos = rev ? rev.length - (v.destPos ?? 0) : 0;
  const gapOk = !rev || opposingGap(world, rev, crossPos, 5.0);
  if (v.waitStart === 0) v.waitStart = world.t;
  if (gapOk) {
    v.waitStart = 0;
    finishTrip(world, v);
    return true;
  }
  // TWLTL: wait in the centre lane instead of blocking the through lane.
  if (road.median === 'twltl' && !v.waitingOffLane) {
    removeFromLane(world, lane, v);
    v.waitingOffLane = true;
    v.speed = 0;
    // Keep it in the lane list logically but off the sorted vehicle list: re-add on completion is unnecessary.
    // We model the wait as a pending left-in on the driveway.
    const dw = link.driveways.find((d) => d.generatorId === v.destGen);
    if (dw) dw.leftInWaiting += 1;
  }
  if (v.waitingOffLane) {
    v.delay += dt;
    if (gapOk || world.t - v.waitStart > 90) {
      const dw = link.driveways.find((d) => d.generatorId === v.destGen);
      if (dw) dw.leftInWaiting = Math.max(0, dw.leftInWaiting - 1);
      finishTrip(world, v);
    }
    return true;
  }
  return false;
}

/** Is there an acceptable gap in `link`'s traffic at `pos` (no vehicle arriving within `critical` seconds)? */
export function opposingGap(world: World, link: Link, pos: number, critical: number): boolean {
  for (const lane of allTrafficLanes(link)) {
    if (lane.type === 'bay') continue;
    for (const id of lane.vehicles) {
      const o = world.vehicles[id];
      const op = posOf(world, id);
      if (op > pos + 2) continue; // already past
      const d = pos - op;
      if (d < vehicleLength(o) + 2) return false;
      const tta = d / Math.max(o.speed, 0.5);
      if (tta < critical) return false;
      break; // vehicles further back are even later
    }
  }
  return true;
}

// ───────────────────────────── median crossovers ─────────────────────────────

function crossoverFor(world: World, v: Vehicle, link: Link) {
  const road = world.roads[link.roadId];
  const fwd = link.id.endsWith('>');
  const pos = (v.place as { pos: number }).pos;
  // First crossover ahead in travel direction that permits this direction.
  let best = null as (typeof road.crossovers)[number] | null;
  let bestD = Infinity;
  for (const xo of road.crossovers) {
    if (xo.kind !== 'uturn') continue;
    if (fwd ? !xo.fwd : !xo.bwd) continue;
    const xpos = fwd ? xo.pos : road.length - xo.pos;
    const d = xpos - pos;
    if (d > -1 && d < bestD) {
      bestD = d;
      best = xo;
    }
  }
  return best;
}

function tryCrossover(world: World, v: Vehicle, lane: Lane, link: Link, xo: { id: string; fwd: boolean; bwd: boolean; signalised: boolean; storage: number; waitingFwd: number[]; waitingBwd: number[]; pos: number }, xpos: number): boolean {
  const fwd = link.id.endsWith('>');
  const road = world.roads[link.roadId];
  const rev = world.links[fwd ? `${road.id}<` : `${road.id}>`];
  if (!rev) return false;
  const waiting = fwd ? xo.waitingFwd : xo.waitingBwd;
  const capacity = Math.max(1, Math.floor(xo.storage / 7));
  if (!v.waitingOffLane) {
    if (waiting.length >= capacity) return false; // bay full: wait in lane (blocks it)
    removeFromLane(world, lane, v);
    waiting.push(v.id);
    v.waitingOffLane = true;
    v.waitStart = world.t;
    v.speed = 0;
    v.place = { kind: 'driveway', linkId: link.id, generatorId: `xo:${xo.id}` };
    return true;
  }
  return true;
}

/** Advance vehicles waiting in crossover bays: FIFO, gap acceptance on the reverse link. */
export function stepCrossovers(world: World, dt: number): void {
  for (const road of Object.values(world.roads)) {
    for (const xo of road.crossovers) {
      for (const dir of ['fwd', 'bwd'] as const) {
        const waiting = dir === 'fwd' ? xo.waitingFwd : xo.waitingBwd;
        if (!waiting.length) continue;
        const rev = world.links[dir === 'fwd' ? `${road.id}<` : `${road.id}>`];
        if (!rev) continue;
        const id = waiting[0];
        const v = world.vehicles[id];
        if (!v) {
          waiting.shift();
          continue;
        }
        v.delay += dt;
        const landing = dir === 'fwd' ? road.length - xo.pos : xo.pos;
        // Signalised crossover: 30 s cycle, 10 s green for U-turns.
        if (xo.signalised && world.t % 30 > 10) continue;
        const ok = opposingGap(world, rev, landing, xo.signalised ? 2.5 : 4.5) || world.t - v.waitStart > 120;
        if (!ok) continue;
        const lane = rev.lanes.find((l) => l.type === 'general') ?? rev.lanes[0];
        const { ahead, behind } = neighboursAt(world, lane, landing, v.id);
        if (ahead && posOf(world, ahead.id) - vehicleLength(ahead) - landing < 3) continue;
        if (behind && landing - vehicleLength(v) - posOf(world, behind.id) < 3) continue;
        waiting.shift();
        v.waitingOffLane = false;
        v.waitStart = 0;
        v.routeIdx += 1;
        v.linkEnterT = world.t;
        v.speed = 2;
        addToLane(world, lane, v, landing);
      }
    }
  }
}

export { currentLink };
