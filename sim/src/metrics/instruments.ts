/** Read-only instrument queries for a renderer: TMC, v/c, O-D, time-space, heatmaps, queues. */
import { dist, ringToArray } from '../core/util.js';
import type { LinkId, NodeId, SimNode, World } from '../model/types.js';
import { allTrafficLanes } from '../network/lanes.js';
import { lostTimePerPhase, planEfficiency } from '../control/signal.js';
import { nextMovement, posOf, queueLength } from '../traffic/access.js';

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

export { lostTimePerPhase, posOf };
