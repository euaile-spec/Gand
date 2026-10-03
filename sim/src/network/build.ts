/** Builds a World from a MapDef. */
import { createRng } from '../core/rng.js';
import { heading, dist, type Point } from '../core/util.js';
import {
  DEFAULT_CONFIG,
  LANE_WIDTH_STANDARD,
  type BusRoute,
  type BusStop,
  type Control,
  type Driveway,
  type Generator,
  type Link,
  type Metrics,
  type NodeLeg,
  type Road,
  type SimNode,
  type World,
  type WorldConfig,
  type LinkId,
  type Leg,
} from '../model/types.js';
import type { MapDef, MapGeneratorDef, MapNodeDef, MapRoadDef } from './mapdef.js';
import { assignLegs, rebuildNodeMovements } from './geometry.js';
import { defaultAllowed, indexLane, makeLane, refreshLinkSpeed } from './lanes.js';

export function emptyMetrics(): Metrics {
  return {
    recent: [],
    peopleMoved: 0,
    peopleDelaySeconds: 0,
    tripsCompleted: 0,
    score: 0,
    gridlock: 0,
    gridlockPeakToday: 0,
    crashes: 0,
    worstApproachDelay: 0,
    linkDelay: {},
    queueHistory: {},
    history: [],
    pedDelaySeconds: 0,
    busLateness: 0,
    violations: 0,
    lostTrips: 0,
  };
}

export function emptyControl(): Control {
  return { type: 'uncontrolled', minorLinks: [], signal: null, runtime: null, roundaboutLanes: 1 };
}

export function emptyNodeMetrics(): SimNode['metrics'] {
  return {
    delayAccum: 0,
    served: 0,
    los: 'A',
    tmcWindow: {},
    tmcLast: {},
    tmcWindowStart: 0,
    demand: {},
    capacity: {},
    conflictScore: 0,
    boxBlockedFor: 0,
    crashes: 0,
  };
}

function polylineLength(pts: Point[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/** Create a directed link with default lanes. */
export function createLink(world: World, road: Road, dir: 'fwd' | 'bwd', nLanes: number, parking: Link['parking']): Link {
  const id: LinkId = dir === 'fwd' ? `${road.id}>` : `${road.id}<`;
  const from = dir === 'fwd' ? road.a : road.b;
  const to = dir === 'fwd' ? road.b : road.a;
  const link: Link = {
    id,
    roadId: road.id,
    from,
    to,
    length: road.length,
    speedLimit: 0,
    lanes: [],
    pocketLeft: null,
    pocketRight: null,
    bays: [],
    parking,
    loadingZone: false,
    curbExtensions: false,
    driveways: [],
    busStops: [],
    crossings: [],
    noLeftIntoDriveways: false,
    mergeStyle: 'taper',
    travelTime: 0,
    freeFlowTime: 0,
    stopPenalty: 0,
    designSpeed: 0,
    constructionUntil: 0,
    wear: 0,
  };
  for (let i = 0; i < nLanes; i++) {
    const lane = makeLane(id, i, 'general', 0, road.length, defaultAllowed(nLanes, i));
    link.lanes.push(lane);
    indexLane(world, lane);
  }
  if (parking !== 'none') {
    const p = makeLane(id, nLanes, 'parking', 0, road.length, [], 2.5);
    link.lanes.push(p);
    indexLane(world, p);
  }
  refreshLinkSpeed(world, link);
  world.links[id] = link;
  return link;
}

export function roadPoints(def: MapRoadDef, nodes: Record<string, Point>): Point[] {
  return [nodes[def.a], ...(def.via ?? []), nodes[def.b]];
}

/** Position along a road a→b at fraction t, plus the link-relative pos for fwd and bwd links. */
export function roadPosAt(road: Road, t: number): { point: Point; fwdPos: number; bwdPos: number } {
  const target = t * road.length;
  let acc = 0;
  for (let i = 1; i < road.points.length; i++) {
    const seg = dist(road.points[i - 1], road.points[i]);
    if (acc + seg >= target || i === road.points.length - 1) {
      const f = seg > 0 ? (target - acc) / seg : 0;
      const p = { x: road.points[i - 1].x + (road.points[i].x - road.points[i - 1].x) * f, y: road.points[i - 1].y + (road.points[i].y - road.points[i - 1].y) * f };
      return { point: p, fwdPos: target, bwdPos: road.length - target };
    }
    acc += seg;
  }
  return { point: road.points[road.points.length - 1], fwdPos: road.length, bwdPos: 0 };
}

/** Node radius from the widest incident road. */
export function nodeRadius(world: World, node: SimNode): number {
  let w = 1;
  for (const leg of node.legs) w = Math.max(w, world.roads[leg.roadId].widthLanes);
  return (w * LANE_WIDTH_STANDARD) / 2 + 2;
}

/** Rebuild one node's legs' in/out links from roads (used after one-way or transforms). */
export function refreshNodeLegs(world: World, node: SimNode): void {
  for (const leg of node.legs) {
    const road = world.roads[leg.roadId];
    const fwd = world.links[`${road.id}>`];
    const bwd = world.links[`${road.id}<`];
    // forward link is a→b; it is inbound to node if node === b.
    const nodeIsB = road.b === node.id;
    leg.inLink = nodeIsB ? (fwd ? fwd.id : null) : bwd ? bwd.id : null;
    leg.outLink = nodeIsB ? (bwd ? bwd.id : null) : fwd ? fwd.id : null;
  }
  node.radius = nodeRadius(world, node);
  // Skew: how far the worst leg sits from its right-angle slot (0° = perfect cross).
  node.skew = 0;
  for (const leg of node.legs) {
    const slotDeg = leg.leg * 90 - 90; // slot 0 = north = -90° in screen coords
    let d = Math.abs((((leg.angle * 180) / Math.PI - slotDeg) % 360 + 540) % 360 - 180);
    node.skew = Math.max(node.skew, Math.min(d, 60));
  }
  rebuildNodeMovements(
    node,
    (l) => world.links[l].speedLimit,
    (r) => world.roads[r].widthLanes * LANE_WIDTH_STANDARD,
  );
}

export function refreshAllNodes(world: World): void {
  for (const n of Object.values(world.nodes)) refreshNodeLegs(world, n);
}

export function buildWorld(def: MapDef, seed = 1, configOverrides: Partial<WorldConfig> = {}): World {
  const config: WorldConfig = { ...DEFAULT_CONFIG, ...configOverrides };
  const world: World = {
    t: 0,
    day: 0,
    week: 0,
    config,
    rng: createRng(seed),
    nodes: {},
    roads: {},
    links: {},
    lanes: {},
    vehicles: {},
    nextVehicleId: 1,
    generators: {},
    busRoutes: {},
    busStops: {},
    resources: { laneKm: def.laneKm ?? 1.0, tokens: def.tokens ?? 0, weeklyLaneKm: def.weeklyLaneKm ?? 1.0, pendingWeeklyChoice: false, spentLaneKm: 0, unlocks: [] },
    constructions: [],
    nextConstructionId: 1,
    incidents: [],
    nextIncidentId: 1,
    events: [],
    nextEventId: 1,
    metrics: emptyMetrics(),
    demandMultiplier: 1,
    gameOver: false,
    lastEditAt: {},
    satFlowFactor: 1,
    corridors: {},
    interchanges: {},
    structureCounts: {},
    pendingGrowth: (def.growth ?? []).map((g) => ({ day: g.day, node: { ...g.node }, road: { ...g.road } as Record<string, unknown>, generator: { ...g.generator } as Record<string, unknown> })),
    grownRoads: [],
  };

  const nodePos: Record<string, Point> = {};
  for (const n of def.nodes) nodePos[n.id] = { x: n.x, y: n.y };

  // Roads and links
  for (const rd of def.roads) {
    const pts = roadPoints(rd, nodePos);
    const fwdLanes = rd.oneWay === 'bwd' ? 0 : (rd.fwdLanes ?? 1);
    const bwdLanes = rd.oneWay === 'fwd' ? 0 : (rd.bwdLanes ?? 1);
    const parkingF = rd.parkingFwd ?? 'none';
    const parkingB = rd.parkingBwd ?? 'none';
    const median = rd.median ?? 'none';
    const widthLanes = rd.widthLanes ?? fwdLanes + bwdLanes + (parkingF !== 'none' ? 1 : 0) + (parkingB !== 'none' ? 1 : 0) + (median !== 'none' ? 1 : 0);
    createRoad(world, rd, pts);
  }

  // Nodes with legs
  for (const nd of def.nodes) createNode(world, nd.id, nodePos[nd.id]);

  refreshAllNodes(world);

  // Generators + driveways
  for (const g of def.generators) addGenerator(world, g);

  // Bus routes
  for (const br of def.busRoutes ?? []) {
    const links: LinkId[] = [];
    for (let i = 0; i < br.nodes.length; i++) {
      const a = br.nodes[i];
      const b = br.nodes[(i + 1) % br.nodes.length];
      const road = Object.values(world.roads).find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
      if (!road) throw new Error(`Bus route ${br.id}: no road between ${a} and ${b}`);
      const id: LinkId = road.a === a ? `${road.id}>` : `${road.id}<`;
      if (!world.links[id]) throw new Error(`Bus route ${br.id}: link ${id} missing (one-way?)`);
      links.push(id);
    }
    const stops: string[] = [];
    br.stops.forEach((s, i) => {
      const road = world.roads[s.roadId];
      const at = roadPosAt(road, s.t);
      const linkId: LinkId = s.side === 'fwd' ? `${road.id}>` : `${road.id}<`;
      const link = world.links[linkId];
      if (!link) throw new Error(`Bus stop on missing link ${linkId}`);
      const stop: BusStop = {
        id: `${br.id}-s${i}`,
        linkId,
        pos: linkId.endsWith('>') ? at.fwdPos : at.bwdPos,
        kind: s.kind ?? 'curbside',
        waiting: { [br.id]: 0 },
        nearSide: (linkId.endsWith('>') ? at.fwdPos : at.bwdPos) > road.length * 0.7,
      };
      world.busStops[stop.id] = stop;
      link.busStops.push(stop);
      stops.push(stop.id);
    });
    const route: BusRoute = { id: br.id, links, stops, headway: br.headway, nextDispatch: 60, depotLink: links[0], activeBuses: [], lateness: 0 };
    world.busRoutes[route.id] = route;
  }

  return world;
}

/** Create a road record and its links from a definition. */
export function createRoad(world: World, rd: MapRoadDef, pts: Point[]): Road {
  const fwdLanes = rd.oneWay === 'bwd' ? 0 : (rd.fwdLanes ?? 1);
  const bwdLanes = rd.oneWay === 'fwd' ? 0 : (rd.bwdLanes ?? 1);
  const parkingF = rd.parkingFwd ?? 'none';
  const parkingB = rd.parkingBwd ?? 'none';
  const median = rd.median ?? 'none';
  const widthLanes = rd.widthLanes ?? fwdLanes + bwdLanes + (parkingF !== 'none' ? 1 : 0) + (parkingB !== 'none' ? 1 : 0) + (median !== 'none' ? 1 : 0);
  const road: Road = {
    id: rd.id,
    a: rd.a,
    b: rd.b,
    length: polylineLength(pts),
    widthLanes,
    fwdLanes,
    bwdLanes,
    oneWay: rd.oneWay ?? 'none',
    median,
    points: pts,
    crossovers: [],
    grade: rd.grade ?? 0,
    curvature: rd.curvature ?? 0,
    frontage: rd.frontage ?? 'open',
    maxWidth: rd.maxWidth ?? widthLanes + (rd.frontage === 'water' ? 0 : rd.frontage === 'built' ? 1 : 2),
  };
  world.roads[road.id] = road;
  if (fwdLanes > 0) createLink(world, road, 'fwd', fwdLanes, parkingF);
  if (bwdLanes > 0) createLink(world, road, 'bwd', bwdLanes, parkingB);
  return road;
}

/** Create a node with legs computed from the roads currently incident to it. */
export function createNode(world: World, id: string, pos: Point): SimNode {
  const node: SimNode = {
    id,
    pos,
    legs: [],
    movements: {},
    conflicts: {},
    peds: {},
    control: emptyControl(),
    boxProtection: true,
    form: 'standard',
    banned: [],
    occupants: [],
    stopQueue: [],
    metrics: emptyNodeMetrics(),
    vms: null,
    radius: 8,
    skew: 0,
  };
  world.nodes[id] = node;
  recomputeLegs(world, node);
  return node;
}

/** Recompute leg slots from incident roads, preserving per-leg settings for roads that stay. */
export function recomputeLegs(world: World, node: SimNode): void {
  const incident = Object.values(world.roads).filter((r) => r.a === node.id || r.b === node.id);
  const headings = incident.map((r) => {
    const next = r.a === node.id ? r.points[1] : r.points[r.points.length - 2];
    return { roadId: r.id, angle: heading(node.pos, next) };
  });
  const slots = assignLegs(headings);
  const prev = new Map(node.legs.map((l) => [l.roadId, l]));
  node.legs = incident.map((r) => {
    const old = prev.get(r.id);
    return {
      leg: slots.get(r.id) as Leg,
      roadId: r.id,
      inLink: null,
      outLink: null,
      angle: headings.find((h) => h.roadId === r.id)!.angle,
      channelisedRight: old?.channelisedRight ?? false,
      slipMode: old?.slipMode ?? 'yield',
      cornerRadius: old?.cornerRadius ?? 'standard',
      laneDrop: old?.laneDrop ?? 'after',
    };
  });
  node.legs.sort((p, q) => p.leg - q.leg);
}

export function addGenerator(world: World, g: MapGeneratorDef): Generator {
  const road = world.roads[g.roadId];
  const at = roadPosAt(road, g.t);
  const linkId: LinkId = g.side === 'fwd' ? `${road.id}>` : `${road.id}<`;
  const link = world.links[linkId] ?? world.links[g.side === 'fwd' ? `${road.id}<` : `${road.id}>`];
  const gen: Generator = {
    id: g.id,
    kind: g.kind,
    size: g.size,
    roadId: g.roadId,
    pos: at.point,
    drivewayLink: link.id,
    opensDay: g.opensDay ?? 0,
    active: (g.opensDay ?? 0) <= world.day,
    lostTrips: 0,
    walkability: 1,
    surgeUntil: 0,
    surgePeople: 0,
  };
  world.generators[gen.id] = gen;
  if (road.frontage === 'open' && g.kind !== 'external' && g.kind !== 'stadium') road.frontage = 'built';
  const dw: Driveway = {
    generatorId: gen.id,
    linkId: link.id,
    pos: link.id.endsWith('>') ? at.fwdPos : at.bwdPos,
    access: 'full',
    throatLength: g.throatLength ?? (g.kind === 'stadium' ? 60 : g.kind === 'school' ? 40 : 20),
    exitQueue: [],
    leftInWaiting: 0,
    sharedWith: [],
  };
  link.driveways.push(dw);
  return gen;
}

/**
 * City growth at runtime: a new stub node and road off an existing node, plus a generator on it.
 * Returns an error string if the attachment node is full (4 legs) or ids collide.
 */
export function addGrowth(world: World, step: { node: MapNodeDef; road: MapRoadDef; generator: MapGeneratorDef }): string | null {
  const attachId = step.road.a === step.node.id ? step.road.b : step.road.a;
  const attach = world.nodes[attachId];
  if (!attach) return `No node ${attachId} to attach to`;
  if (attach.legs.length >= 4) return `${attachId} already has four legs`;
  if (world.nodes[step.node.id] || world.roads[step.road.id] || world.generators[step.generator.id]) return 'Growth ids collide with existing ones';
  const pos = { x: step.node.x, y: step.node.y };
  // Create the stub node first (no legs yet), then the road, then legs on both ends.
  const nodePos: Record<string, Point> = { [step.node.id]: pos, [attachId]: attach.pos };
  const stub = createNode(world, step.node.id, pos);
  createRoad(world, step.road, roadPoints(step.road, nodePos));
  recomputeLegs(world, stub);
  recomputeLegs(world, attach);
  refreshNodeLegs(world, stub);
  refreshNodeLegs(world, attach);
  addGenerator(world, step.generator);
  world.grownRoads.push(step.road.id);
  return null;
}
