/** Read-only instrument queries for a renderer: TMC, v/c, O-D, time-space, heatmaps, queues. */
import { dist, ringToArray } from '../core/util.js';
import type { LinkId, NodeId, SimNode, World } from '../model/types.js';
import { allTrafficLanes } from '../network/lanes.js';
import { lostTimePerPhase, planEfficiency } from '../control/signal.js';
import { nextMovement, posOf, queueLength } from '../traffic/access.js';
import { sightDistance, sightLimitedSpeed } from '../traffic/dynamics.js';

export interface MovementReport {
  key: string;
  turn: string;
  fromLink: LinkId;
  toLink: LinkId;
  demand: number; // veh/h
  capacity: number; // veh/h
  vc: number;
  countWindow: number;
}

export function turningMovements(world: World, nodeId: NodeId): MovementReport[] {
  const node = world.nodes[nodeId];
  return Object.values(node.movements).map((m) => {
    const d = node.metrics.demand[m.key] ?? 0;
    const c = node.metrics.capacity[m.key] ?? 0;
    return { key: m.key, turn: m.turn, fromLink: m.fromLink, toLink: m.toLink, demand: d, capacity: c, vc: c > 0 ? d / c : d > 0 ? 9 : 0, countWindow: node.metrics.tmcWindow[m.key] ?? 0 };
  });
}

export interface NodeReport {
  id: NodeId;
  los: SimNode['metrics']['los'];
  avgDelay: number;
  control: string;
  conflictScore: number;
  boxBlocked: boolean;
  signal: { cycle: number; phases: number; lostTime: number; efficiency: number } | null;
  movements: MovementReport[];
  peds: { leg: number; waiting: number; delay: number }[];
}

export function nodeReport(world: World, nodeId: NodeId): NodeReport {
  const node = world.nodes[nodeId];
  const plan = node.control.signal;
  const eff = plan && node.control.type === 'signal' ? planEfficiency(node, world, plan) : null;
  return {
    id: node.id,
    los: node.metrics.los,
    avgDelay: node.metrics.served ? node.metrics.delayAccum / node.metrics.served : 0,
    control: node.control.type + (node.control.runtime?.malfunction ? ' (FLASHING RED)' : ''),
    conflictScore: node.metrics.conflictScore,
    boxBlocked: node.metrics.boxBlockedFor > 0,
    signal: plan && eff ? { cycle: plan.cycle, phases: plan.phases.length, lostTime: eff.lost, efficiency: eff.efficiency } : null,
    movements: turningMovements(world, nodeId),
    peds: Object.values(node.peds).map((p) => ({ leg: p.leg, waiting: p.waiting, delay: p.delayAccum })),
  };
}

/** Origins/destinations of vehicles currently queued for a movement. */
export function odForMovement(world: World, nodeId: NodeId, movementKey: string): { pairs: { origin: string; dest: string; count: number }[]; vehicles: number } {
  const node = world.nodes[nodeId];
  const m = node.movements[movementKey];
  const counts = new Map<string, { origin: string; dest: string; count: number }>();
  let n = 0;
  if (!m) return { pairs: [], vehicles: 0 };
  const link = world.links[m.fromLink];
  for (const lane of allTrafficLanes(link)) {
    for (const id of lane.vehicles) {
      const v = world.vehicles[id];
      const nm = nextMovement(world, v);
      if (!nm || nm.key !== m.key) continue;
      n++;
      const key = `${v.originGen ?? '?'}→${v.destGen ?? (v.cyclic ? 'bus' : '?')}`;
      const e = counts.get(key) ?? { origin: v.originGen ?? '?', dest: v.destGen ?? (v.cyclic ? 'bus' : '?'), count: 0 };
      e.count++;
      counts.set(key, e);
    }
  }
  return { pairs: [...counts.values()].sort((a, b) => b.count - a.count), vehicles: n };
}

export interface TimeSpaceNode {
  nodeId: NodeId;
  distance: number;
  /** Green intervals (absolute sim seconds) for the corridor's through movement in each direction. */
  greensFwd: [number, number][];
  greensBwd: [number, number][];
  cycle: number;
  offset: number;
}

/** Data for a time–space diagram along a corridor of node ids. */
export function timeSpaceData(world: World, corridor: NodeId[], horizon = 300): TimeSpaceNode[] {
  const out: TimeSpaceNode[] = [];
  let distance = 0;
  const since = world.t - horizon;
  for (let i = 0; i < corridor.length; i++) {
    const node = world.nodes[corridor[i]];
    if (!node) continue;
    if (i > 0) distance += dist(world.nodes[corridor[i - 1]].pos, node.pos);
    const plan = node.control.signal;
    const rt = node.control.runtime;
    const greensFwd: [number, number][] = [];
    const greensBwd: [number, number][] = [];
    if (plan && rt) {
      const next = corridor[i + 1];
      const prev = corridor[i - 1];
      const fwdMove = Object.values(node.movements).find((m) => m.turn === 'T' && next && world.links[m.toLink].to === next);
      const bwdMove = Object.values(node.movements).find((m) => m.turn === 'T' && prev && world.links[m.toLink].to === prev);
      for (const g of rt.greenLog) {
        const end = g.end || world.t;
        if (end < since) continue;
        const ph = plan.phases[g.phase];
        if (!ph) continue;
        if (fwdMove && ph.movements.includes(fwdMove.key)) greensFwd.push([g.start, end]);
        if (bwdMove && ph.movements.includes(bwdMove.key)) greensBwd.push([g.start, end]);
      }
    }
    out.push({ nodeId: node.id, distance, greensFwd, greensBwd, cycle: plan?.cycle ?? 0, offset: plan?.offset ?? 0 });
  }
  return out;
}

export function delayHeatmap(world: World): { linkId: LinkId; delay: number; occupancy: number; wear: number }[] {
  return Object.values(world.links).map((l) => {
    let veh = 0;
    for (const lane of allTrafficLanes(l)) veh += lane.vehicles.length;
    return { linkId: l.id, delay: world.metrics.linkDelay[l.id] ?? 0, occupancy: veh, wear: l.wear };
  });
}

/** Pavement condition overlay: worst links first. */
export function pavementReport(world: World): { roadId: string; wear: number; grown: boolean }[] {
  return Object.values(world.roads)
    .map((r) => ({ roadId: r.id, wear: Math.max(world.links[`${r.id}>`]?.wear ?? 0, world.links[`${r.id}<`]?.wear ?? 0), grown: world.grownRoads.includes(r.id) }))
    .sort((a, b) => b.wear - a.wear);
}

export function queueReport(world: World, linkId: LinkId): { laneId: string; queue: number; maxHour: number; history: number[] }[] {
  const link = world.links[linkId];
  return allTrafficLanes(link)
    .filter((l) => l.type !== 'bay')
    .map((lane) => {
      const r = world.metrics.queueHistory[lane.id];
      const hist = r ? ringToArray(r) : [];
      return { laneId: lane.id, queue: queueLength(world, lane), maxHour: Math.max(0, ...hist.slice(-60)), history: hist };
    });
}

export function conflictOverlay(world: World): { nodeId: NodeId; score: number; crashes: number }[] {
  return Object.values(world.nodes).map((n) => ({ nodeId: n.id, score: n.metrics.conflictScore, crashes: n.metrics.crashes }));
}

export function transitOverlay(world: World) {
  return Object.values(world.busRoutes).map((r) => ({
    routeId: r.id,
    buses: r.activeBuses
      .map((id) => world.vehicles[id])
      .filter(Boolean)
      .map((b) => ({ id: b.id, load: b.people, place: b.place, dwelling: b.dwelling })),
    waiting: r.stops.map((s) => ({ stopId: s, waiting: world.busStops[s]?.waiting[r.id] ?? 0 })),
  }));
}

export function hudSummary(world: World) {
  const h = world.metrics.history;
  const last = h[h.length - 1];
  return {
    t: world.t,
    day: world.day,
    week: world.week,
    peoplePerHour: last?.flow ?? 0,
    avgDelay: last?.delay ?? 0,
    gridlock: world.metrics.gridlock,
    score: Math.round(world.metrics.score),
    laneKm: world.resources.laneKm,
    tokens: world.resources.tokens,
    pendingWeeklyChoice: world.resources.pendingWeeklyChoice,
    vehicles: Object.keys(world.vehicles).length,
    crashes: world.metrics.crashes,
    incidents: world.incidents.length,
    gameOver: world.gameOver,
    worstWear: Math.max(0, ...Object.values(world.links).map((l) => l.wear)),
    pendingGrowth: world.pendingGrowth.length,
  };
}

/**
 * Storage vs discharge: can the block downstream of a signal hold what the upstream signal releases per cycle?
 * ratio > 1 means the green discharges more than the block can store → spillback into the upstream node.
 */
export function storageReport(world: World, nodeId: NodeId): { linkId: LinkId; storageVehicles: number; dischargePerCycle: number; ratio: number; risk: boolean }[] {
  const node = world.nodes[nodeId];
  const out: { linkId: LinkId; storageVehicles: number; dischargePerCycle: number; ratio: number; risk: boolean }[] = [];
  for (const leg of node.legs) {
    if (!leg.inLink) continue;
    const link = world.links[leg.inLink];
    const lanes = link.lanes.filter((l) => l.type === 'general').length || 1;
    const storage = Math.max(1, Math.floor(((link.length - 15) / 7) * lanes));
    // Upstream node's signal discharge into this link.
    const up = world.nodes[link.from];
    let discharge = 0;
    if (up?.control.type === 'signal' && up.control.signal?.cycle) {
      const plan = up.control.signal;
      for (const m of Object.values(up.movements)) {
        if (m.toLink !== link.id) continue;
        let g = 0;
        for (const p of plan.phases) if (p.movements.includes(m.key)) g += p.split;
        const laneCount = world.links[m.fromLink].lanes.filter((l) => l.type === 'general' && l.allowed.includes(m.turn)).length || 1;
        discharge += (1900 / 3600) * g * laneCount * (m.turn === 'T' ? 1 : 0.6);
      }
    } else {
      // Unsignalised upstream: a platoon is whatever arrives in one downstream cycle.
      const cyc = node.control.signal?.cycle ?? 60;
      discharge = Object.values(node.metrics.demand).filter((_, i) => i >= 0).reduce((s, d) => s, 0) + (Object.entries(node.metrics.demand).filter(([k]) => k.startsWith(link.id)).reduce((s, [, d]) => s + d, 0) * cyc) / 3600;
    }
    const ratio = discharge / storage;
    out.push({ linkId: link.id, storageVehicles: storage, dischargePerCycle: discharge, ratio, risk: ratio > 0.9 });
  }
  return out;
}

/** Weaving sections (on-ramp merge followed by off-ramp) with their length and an intensity 0..1. */
export function weavingSections(world: World): { linkId: LinkId; length: number; intensity: number; warning: boolean }[] {
  const out: { linkId: LinkId; length: number; intensity: number; warning: boolean }[] = [];
  for (const link of Object.values(world.links)) {
    const aux = link.lanes.find((l) => l.ramp && l.type === 'general' && l.start === 0);
    const off = link.pocketRight?.ramp ? link.pocketRight : null;
    if (!aux || !off) continue;
    const length = Math.max(0, off.start - aux.end);
    out.push({ linkId: link.id, length, intensity: Math.max(0, Math.min(1, 1 - length / 300)), warning: length < 150 });
  }
  return out;
}

/** Offset intersections: short roads joining two T-junctions, candidates for realignment. */
export function offsetIntersections(world: World): { roadId: string; length: number; nodes: [NodeId, NodeId]; realignCostKm: number }[] {
  const out: { roadId: string; length: number; nodes: [NodeId, NodeId]; realignCostKm: number }[] = [];
  for (const road of Object.values(world.roads)) {
    if (road.length > 60) continue;
    const a = world.nodes[road.a];
    const b = world.nodes[road.b];
    if (a?.legs.length === 3 && b?.legs.length === 3) {
      const mult = road.frontage === 'open' ? 1 : road.frontage === 'parkland' ? 2 : road.frontage === 'built' ? 3 : 6;
      out.push({ roadId: road.id, length: road.length, nodes: [road.a, road.b], realignCostKm: 0.1 * mult });
    }
  }
  return out;
}

/** Sight and geometry per approach of a node. */
export function geometryReport(world: World, nodeId: NodeId): { skew: number; approaches: { linkId: LinkId; grade: number; curvature: number; sightDistance: number; sightLimitedSpeed: number | null }[] } {
  const node = world.nodes[nodeId];
  const approaches = node.legs
    .filter((l) => l.inLink)
    .map((l) => {
      const link = world.links[l.inLink!];
      const road = world.roads[link.roadId];
      return { linkId: link.id, grade: road.grade, curvature: road.curvature, sightDistance: sightDistance(world, link), sightLimitedSpeed: sightLimitedSpeed(world, link) };
    });
  return { skew: node.skew, approaches };
}

/**
 * Progression bandwidth along a corridor in one direction: the share of the cycle during which a platoon
 * leaving the first signal at free-flow speed meets green at every downstream signal. Needs a common cycle.
 */
export function bandwidthReport(world: World, corridor: NodeId[], reverse = false): { cycle: number; bandSeconds: number; bandShare: number; coordinated: boolean } {
  const ids = reverse ? [...corridor].reverse() : corridor;
  const nodes = ids.map((id) => world.nodes[id]).filter(Boolean);
  const plans = nodes.map((n) => n.control.signal);
  if (nodes.length < 2 || plans.some((p) => !p || !p.cycle)) return { cycle: 0, bandSeconds: 0, bandShare: 0, coordinated: false };
  const cycle = plans[0]!.cycle;
  const coordinated = plans.every((p) => Math.abs(p!.cycle - cycle) < 0.5 && p!.coordinated);
  // Green windows (mod cycle) of the through movement toward the next node, from the schedule.
  const windows: [number, number][] = [];
  let travel = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const plan = n.control.signal!;
    const next = ids[i + 1];
    const prev = ids[i - 1];
    const through = Object.values(n.movements).find((m) => m.turn === 'T' && ((next && world.links[m.toLink].to === next) || (!next && prev && world.links[m.fromLink].from === prev)));
    if (!through) return { cycle, bandSeconds: 0, bandShare: 0, coordinated };
    let acc = 0;
    let start = -1;
    let end = -1;
    const inter = lostTimePerPhase(n, world) - 2; // approx yellow + all-red
    for (const p of plan.phases) {
      if (p.movements.includes(through.key)) {
        start = acc;
        end = acc + p.split;
        break;
      }
      acc += p.split + inter;
    }
    if (start < 0) return { cycle, bandSeconds: 0, bandShare: 0, coordinated };
    const offset = ((plan.offset % cycle) + cycle) % cycle;
    // Shift into the first signal's frame: subtract travel time to this node.
    const s = (((start + offset - travel) % cycle) + cycle) % cycle;
    windows.push([s, s + (end - start)]);
    if (next) {
      const link = Object.values(world.links).find((l) => l.from === n.id && l.to === next);
      travel += link ? link.length / link.speedLimit : 0;
    }
  }
  // Intersect windows on the circle: sample the cycle at 0.5 s.
  let band = 0;
  for (let t = 0; t < cycle; t += 0.5) {
    const ok = windows.every(([s, e]) => {
      const x = ((t - s) % cycle + cycle) % cycle;
      return x <= e - s;
    });
    if (ok) band += 0.5;
  }
  return { cycle, bandSeconds: band, bandShare: band / cycle, coordinated };
}

export { lostTimePerPhase, posOf };
