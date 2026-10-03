/** Trip generation, mode choice, vehicle creation and bus dispatch. */
import { chance, nextFloat, pickWeighted, poissonEvent } from '../core/rng.js';
import { dist } from '../core/util.js';
import { VEHICLE_PARAMS, type Generator, type LinkId, type Vehicle, type VehicleClass, type World } from '../model/types.js';
import { destinationLinks, originLinks, routeFreeFlow, shortestPath } from '../routing/routing.js';
import { throatCapacity } from '../traffic/driveways.js';
import { addToLane, entryRoom } from '../traffic/access.js';
import { affinity, attraction, production, timeOfDay } from './profiles.js';

export function newVehicle(world: World, cls: VehicleClass, people: number): Vehicle {
  const v: Vehicle = {
    id: world.nextVehicleId++,
    cls,
    people,
    place: { kind: 'done' },
    speed: 0,
    accel: 0,
    route: [],
    routeIdx: 0,
    originGen: null,
    destGen: null,
    destPos: null,
    spawnTime: world.t,
    freeFlowTime: 0,
    delay: 0,
    patience: 1,
    laneChangeTarget: null,
    stopLineArrival: 0,
    hasStopped: false,
    stoppedFor: 0,
    busRoute: null,
    busStopIdx: 0,
    dwellUntil: 0,
    nextReroute: world.t + world.config.rerouteInterval,
    nonCompliant: false,
    improvising: false,
    dwelling: false,
    nodeEnterTime: 0,
    violations: 0,
    linkEnterT: world.t,
    approachDelay: 0,
    cyclic: false,
    waitingOffLane: false,
    waitStart: 0,
    lastLaneChangeT: 0,
  };
  world.vehicles[v.id] = v;
  return v;
}

/** Choose a destination generator for a trip from `o`. */
function chooseDestination(world: World, o: Generator, tod: number): Generator | null {
  const gens = Object.values(world.generators).filter((g) => g.active && g.id !== o.id);
  if (!gens.length) return null;
  const weights = gens.map((g) => {
    const d = dist(o.pos, g.pos);
    const decay = 1 / (1 + d / 800);
    return attraction(g.kind, tod) * g.size * affinity(o.kind, g.kind) * decay;
  });
  return gens[pickWeighted(world.rng, weights)];
}

/** Is there a bus route with stops near both generators (walk ≤ 150 m)? */
function busServes(world: World, a: Generator, b: Generator): boolean {
  for (const route of Object.values(world.busRoutes)) {
    let nearA = false;
    let nearB = false;
    for (const sid of route.stops) {
      const s = world.busStops[sid];
      const p = stopPoint(world, s.linkId, s.pos);
      if (dist(p, a.pos) < 150) nearA = true;
      if (dist(p, b.pos) < 150) nearB = true;
    }
    if (nearA && nearB) return true;
  }
  return false;
}

function stopPoint(world: World, linkId: LinkId, pos: number) {
  const link = world.links[linkId];
  const road = world.roads[link.roadId];
  const t = linkId.endsWith('>') ? pos / road.length : 1 - pos / road.length;
  const a = road.points[0];
  const b = road.points[road.points.length - 1];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function nearestStop(world: World, g: Generator): { routeId: string; stopId: string } | null {
  let best: { routeId: string; stopId: string; d: number } | null = null;
  for (const route of Object.values(world.busRoutes)) {
    for (const sid of route.stops) {
      const s = world.busStops[sid];
      const d = dist(stopPoint(world, s.linkId, s.pos), g.pos);
      if (d < 150 && (!best || d < best.d)) best = { routeId: route.id, stopId: sid, d };
    }
  }
  return best;
}

/** Create a vehicle trip from generator o to d. Returns false if no route or throat full. */
export function spawnTrip(world: World, o: Generator, d: Generator, cls: VehicleClass, people: number): boolean {
  const oLink = world.links[o.drivewayLink];
  const dw = oLink.driveways.find((x) => x.generatorId === o.id);
  if (!dw) return false;
  if (dw.exitQueue.length >= throatCapacity(dw)) {
    o.lostTrips += 1;
    world.metrics.lostTrips += 1;
    return false;
  }
  const dests = destinationLinks(world, d.id);
  const ddw = world.links[d.drivewayLink].driveways.find((x) => x.generatorId === d.id)!;
  let best: { origin: LinkId; path: LinkId[]; cost: number } | null = null;
  for (const origin of originLinks(world, o.id)) {
    const originFrac = origin === oLink.id ? dw.pos / oLink.length : 1 - dw.pos / oLink.length;
    const path = shortestPath(world, origin, { cls, destLinks: dests, originFraction: originFrac });
    if (!path) continue;
    let cost = 0;
    for (const id of path) cost += world.links[id].travelTime;
    if (origin !== oLink.id) cost += 15; // left-out is harder
    if (!best || cost < best.cost) best = { origin, path, cost };
  }
  // Same-link trip (destination driveway ahead on the same link).
  if (!best) {
    for (const origin of originLinks(world, o.id)) {
      if (!dests.includes(origin)) continue;
      const startPos = origin === oLink.id ? dw.pos : oLink.length - dw.pos;
      const endPos = origin === d.drivewayLink ? ddw.pos : world.links[origin].length - ddw.pos;
      if (endPos > startPos + 10) best = { origin, path: [origin], cost: 0 };
    }
  }
  if (!best) return false;
  const v = newVehicle(world, cls, people);
  v.originGen = o.id;
  v.destGen = d.id;
  v.route = best.path;
  const last = best.path[best.path.length - 1];
  v.destPos = last === d.drivewayLink ? ddw.pos : world.links[last].length - ddw.pos;
  const startFrac = best.origin === oLink.id ? dw.pos / oLink.length : 1 - dw.pos / oLink.length;
  v.freeFlowTime = routeFreeFlow(world, best.path, startFrac, v.destPos) + 5;
  v.nonCompliant = chance(world.rng, world.config.nonComplianceShare);
  v.place = { kind: 'driveway', linkId: oLink.id, generatorId: o.id };
  dw.exitQueue.push(v.id);
  return true;
}

/** Generate trips for this tick. */
export function generateDemand(world: World, dt: number): void {
  const tod = timeOfDay(world);
  const cfg = world.config;
  for (const o of Object.values(world.generators)) {
    if (!o.active) continue;
    let perHour = o.size * cfg.baseTripsPerHourPerSize * production(o.kind, tod) * world.demandMultiplier;
    if (o.surgeUntil > world.t) perHour += o.surgePeople;
    if (!poissonEvent(world.rng, perHour / 3600, dt)) continue;
    const d = chooseDestination(world, o, tod);
    if (!d) continue;
    // Mode choice
    if (busServes(world, o, d) && chance(world.rng, cfg.busShare)) {
      const ns = nearestStop(world, o);
      if (ns) {
        const stop = world.busStops[ns.stopId];
        stop.waiting[ns.routeId] = (stop.waiting[ns.routeId] ?? 0) + 1;
        continue;
      }
    }
    let cls: VehicleClass = 'car';
    if (d.kind === 'shop' && chance(world.rng, cfg.truckShare * 4)) cls = 'truck';
    else if (chance(world.rng, cfg.truckShare)) cls = 'truck';
    if ((d.kind === 'hospital' || o.kind === 'hospital') && chance(world.rng, 0.03)) cls = 'emergency';
    const people = cls === 'car' ? (nextFloat(world.rng) < 0.3 ? 2 : 1) : 1;
    spawnTrip(world, o, d, cls, people);
  }
}

/** Dispatch buses on their headway from the depot link start. */
/** Buses needed to hold the headway: loop time / headway (observed travel times + dwell). */
export function fleetSize(world: World, route: { links: LinkId[]; stops: string[]; headway: number }): number {
  let loop = 0;
  for (const id of route.links) loop += world.links[id]?.travelTime ?? 0;
  loop += route.stops.length * 20 + route.links.length * 8;
  return Math.max(1, Math.ceil(loop / route.headway));
}

export function dispatchBuses(world: World): void {
  for (const route of Object.values(world.busRoutes)) {
    route.activeBuses = route.activeBuses.filter((id) => world.vehicles[id]);
    if (world.t < route.nextDispatch) continue;
    if (route.activeBuses.length >= fleetSize(world, route)) {
      route.nextDispatch = world.t + 30; // fleet is out; check again shortly
      continue;
    }
    const link = world.links[route.links[0]];
    if (!link) continue;
    const drivable = link.lanes.filter((l) => l.type === 'general' || l.type === 'bus');
    const lane = drivable[drivable.length - 1];
    if (!lane || entryRoom(world, lane) < VEHICLE_PARAMS.bus.length + 3) continue; // wait for room
    const bus = newVehicle(world, 'bus', 5);
    bus.busRoute = route.id;
    bus.cyclic = true;
    bus.route = [...route.links];
    bus.routeIdx = 0;
    bus.busStopIdx = 0;
    bus.speed = 3;
    addToLane(world, lane, bus, 0);
    route.activeBuses.push(bus.id);
    route.nextDispatch = world.t + route.headway;
    // Buses stay in service for a bounded time to keep the fleet finite.
    bus.freeFlowTime = 0;
  }
}
