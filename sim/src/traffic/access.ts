/** Vehicle / lane membership helpers and route queries. */
import { insertSortedDesc, removeFromArray } from '../core/util.js';
import { VEHICLE_PARAMS, type Lane, type LinkId, type Movement, type SimNode, type Vehicle, type VehicleParams, type World } from '../model/types.js';
import { allTrafficLanes, lanesAllowing } from '../network/lanes.js';

export function params(v: Vehicle): VehicleParams {
  return VEHICLE_PARAMS[v.cls];
}

export function vehicleLength(v: Vehicle): number {
  return VEHICLE_PARAMS[v.cls].length;
}

export function addToLane(world: World, lane: Lane, v: Vehicle, pos: number): void {
  v.place = { kind: 'lane', laneId: lane.id, pos };
  insertSortedDesc(lane.vehicles, v.id, (id) => posOf(world, id));
}

export function removeFromLane(world: World, lane: Lane, v: Vehicle): void {
  removeFromArray(lane.vehicles, v.id);
}

export function posOf(world: World, id: number): number {
  const p = world.vehicles[id].place;
  return p.kind === 'lane' ? p.pos : p.kind === 'node' ? p.pos : 0;
}

/** Re-sort a lane after positions moved (positions only increase so order rarely changes). */
export function resortLane(world: World, lane: Lane): void {
  lane.vehicles.sort((a, b) => posOf(world, b) - posOf(world, a));
}

export function currentLink(v: Vehicle): LinkId | null {
  return v.route[v.routeIdx] ?? null;
}

export function nextLink(v: Vehicle): LinkId | null {
  if (v.routeIdx + 1 < v.route.length) return v.route[v.routeIdx + 1];
  if (v.cyclic && v.route.length) return v.route[0];
  return null;
}

/** The movement this vehicle will perform at the end of its current link, or null if it ends here. */
export function nextMovement(world: World, v: Vehicle): Movement | null {
  const cur = currentLink(v);
  const nxt = nextLink(v);
  if (!cur || !nxt) return null;
  const link = world.links[cur];
  if (!link) return null;
  // A reverse-link successor means a mid-block U-turn at a crossover, not a node movement.
  if (world.links[nxt]?.roadId === link.roadId && nxt !== cur) return null;
  const node = world.nodes[link.to];
  for (const m of Object.values(node.movements)) if (m.fromLink === cur && m.toLink === nxt) return m;
  return null;
}

export function isCrossoverNext(world: World, v: Vehicle): boolean {
  const cur = currentLink(v);
  const nxt = nextLink(v);
  if (!cur || !nxt || cur === nxt) return false;
  return world.links[nxt]?.roadId === world.links[cur]?.roadId;
}

export function nodeOf(world: World, v: Vehicle): SimNode | null {
  const cur = currentLink(v);
  return cur ? world.nodes[world.links[cur].to] : null;
}

/** Lanes the vehicle may be in to perform its next turn on the given link. */
export function requiredLanes(world: World, v: Vehicle, linkId: LinkId): Lane[] {
  const link = world.links[linkId];
  const m = nextMovement(world, v);
  // Bus heading for a bay stop on this link must get into the bay.
  if (v.cls === 'bus' && v.busRoute) {
    const route = world.busRoutes[v.busRoute];
    const stop = route ? world.busStops[route.stops[v.busStopIdx % Math.max(1, route.stops.length)]] : null;
    if (stop && stop.linkId === linkId && stop.kind === 'bay' && v.place.kind === 'lane' && v.place.pos < stop.pos) {
      const bay = link.bays.find((b) => b.start <= stop.pos && stop.pos <= b.end);
      if (bay) return [bay];
    }
  }
  if (isCrossoverNext(world, v)) {
    // Must be in the leftmost lane (or left pocket) to use the median crossover.
    return [link.pocketLeft ?? allTrafficLanes(link).filter((l) => l.type !== 'bay')[0]].filter(Boolean) as Lane[];
  }
  if (!m) {
    // Ending on this link: destination driveway. Right-in needs the rightmost general lane; left-in the leftmost.
    const general = link.lanes.filter((l) => l.type === 'general' || (l.type === 'bus' && v.cls === 'bus'));
    if (v.destPos === null) return general;
    return v.place.kind === 'lane' && destinationIsLeftIn(world, v) ? [general[0]] : [general[general.length - 1]];
  }
  const lanes = lanesAllowing(link, m.turn, v.cls).filter((l) => !l.busOnly || v.cls === 'bus');
  return lanes;
}

/** True if the destination driveway is on the reverse link (vehicle turns left across traffic). */
export function destinationIsLeftIn(world: World, v: Vehicle): boolean {
  if (!v.destGen) return false;
  const gen = world.generators[v.destGen];
  const last = v.route[v.route.length - 1];
  return gen.drivewayLink !== last;
}

export function leaderInLane(world: World, lane: Lane, v: Vehicle): Vehicle | null {
  const i = lane.vehicles.indexOf(v.id);
  if (i <= 0) return null;
  return world.vehicles[lane.vehicles[i - 1]];
}

/** First vehicle in `lane` strictly ahead of `pos` and the first strictly behind. */
export function neighboursAt(world: World, lane: Lane, pos: number, exclude: number): { ahead: Vehicle | null; behind: Vehicle | null } {
  let ahead: Vehicle | null = null;
  let behind: Vehicle | null = null;
  for (const id of lane.vehicles) {
    if (id === exclude) continue;
    const o = world.vehicles[id];
    const p = posOf(world, id);
    if (p >= pos) ahead = o;
    else {
      behind = o;
      break;
    }
  }
  return { ahead, behind };
}

export function lastVehicleIn(world: World, lane: Lane): Vehicle | null {
  if (!lane.vehicles.length) return null;
  return world.vehicles[lane.vehicles[lane.vehicles.length - 1]];
}

/** Free space at the start of a lane (metres) before the rear of its last vehicle. */
export function entryRoom(world: World, lane: Lane): number {
  const last = lastVehicleIn(world, lane);
  if (!last) return lane.end - lane.start;
  return posOf(world, last.id) - vehicleLength(last) - lane.start;
}

/** Occupancy of a link: vehicle length / lane length summed. */
export function linkOccupancy(world: World, linkId: LinkId): number {
  const link = world.links[linkId];
  let used = 0;
  let cap = 0;
  for (const lane of allTrafficLanes(link)) {
    if (lane.type === 'bay') continue;
    cap += lane.end - lane.start;
    for (const id of lane.vehicles) used += vehicleLength(world.vehicles[id]) + 2;
  }
  return cap > 0 ? Math.min(1, used / cap) : 0;
}

/** Distance from the stop line to the rear of the standing queue in a lane. */
export function queueLength(world: World, lane: Lane): number {
  let tail = lane.end;
  let any = false;
  for (const id of lane.vehicles) {
    const v = world.vehicles[id];
    const p = posOf(world, id);
    if (v.speed > 2.0) break;
    if (lane.end - p > 200 && !any) break;
    tail = p - vehicleLength(v);
    any = true;
  }
  return any ? Math.max(0, lane.end - tail) : 0;
}
