/** Rolling metrics, LOS, v/c, gridlock meter, queue histories. */
import { ringCreate, ringPush } from '../core/util.js';
import { LOS_THRESHOLDS, type SimNode, type World } from '../model/types.js';
import { allTrafficLanes, laneSatFlow, lanesAllowing } from '../network/lanes.js';
import { signalCapacities, slipCapacity } from '../control/signal.js';
import { queueLength } from '../traffic/access.js';

const TMC_WINDOW = 900; // 15 min

export function losFor(delay: number): SimNode['metrics']['los'] {
  for (const [th, l] of LOS_THRESHOLDS) if (delay <= th) return l;
  return 'F';
}

/** HCM-style potential capacity for a minor movement facing conflicting flow vc (veh/h). */
function gapCapacity(vc: number, tc: number, tf: number): number {
  if (vc <= 0) return 3600 / tf;
  const a = Math.exp((-vc * tc) / 3600);
  const b = 1 - Math.exp((-vc * tf) / 3600);
  return (vc * a) / Math.max(1e-6, b);
}

/** Demand (veh/h) per movement from the TMC window. */
function demandEstimate(node: SimNode, world: World): Record<string, number> {
  const out: Record<string, number> = {};
  const elapsed = Math.max(60, world.t - node.metrics.tmcWindowStart);
  const keys = new Set([...Object.keys(node.metrics.tmcWindow), ...Object.keys(node.metrics.tmcLast)]);
  for (const k of keys) {
    const cur = (node.metrics.tmcWindow[k] ?? 0) * (3600 / elapsed);
    const last = (node.metrics.tmcLast[k] ?? 0) * (3600 / TMC_WINDOW);
    const w = Math.min(1, elapsed / TMC_WINDOW);
    out[k] = cur * w + last * (1 - w);
  }
  return out;
}

function unsignalisedCapacities(node: SimNode, world: World, demand: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  const c = node.control;
  for (const m of Object.values(node.movements)) {
    const lanes = lanesAllowing(world.links[m.fromLink], m.turn).length || 1;
    if (m.slip) {
      out[m.key] = slipCapacity(node, m, lanes);
      continue;
    }
    // Conflicting flow: sum of demand on movements with a cross conflict that have priority.
    let vc = 0;
    for (const o of Object.values(node.movements)) {
      if (o.key === m.key) continue;
      const k = node.conflicts[m.key]?.[o.key];
      if (k === 'cross' || k === 'merge') vc += demand[o.key] ?? 0;
    }
    switch (c.type) {
      case 'uncontrolled':
        out[m.key] = lanes * (m.turn === 'L' || m.turn === 'U' ? gapCapacity(vc, 4.5, 2.5) : Math.min(1700, gapCapacity(vc * 0.5, 4.0, 2.2)));
        break;
      case 'two-way-stop':
      case 'yield':
        if (c.minorLinks.includes(m.fromLink)) out[m.key] = lanes * gapCapacity(vc, c.type === 'yield' ? 5.0 : m.turn === 'L' ? 7.1 : m.turn === 'R' ? 6.2 : 6.5, 3.3);
        else out[m.key] = lanes * (m.turn === 'L' || m.turn === 'U' ? gapCapacity(vc, 4.1, 2.2) : 1700);
        break;
      case 'all-way-stop':
        out[m.key] = lanes * 550;
        break;
      case 'roundabout':
        out[m.key] = lanes * 1130 * Math.exp(-0.001 * vc) * (c.roundaboutLanes > 1 ? 1.3 : 1);
        break;
      default:
        out[m.key] = lanes * 1700;
    }
  }
  return out;
}

/** Per-minute metrics refresh for nodes: LOS, demand, capacity. */
export function refreshNodeMetrics(world: World): void {
  for (const node of Object.values(world.nodes)) {
    const nm = node.metrics;
    if (world.t - nm.tmcWindowStart >= TMC_WINDOW) {
      nm.tmcLast = nm.tmcWindow;
      nm.tmcWindow = {};
      nm.tmcWindowStart = world.t;
      // LOS from the window's average control delay.
      nm.los = losFor(nm.served ? nm.delayAccum / nm.served : 0);
      nm.delayAccum *= 0.3;
      nm.served = Math.round(nm.served * 0.3);
    } else if (nm.served > 10) nm.los = losFor(nm.delayAccum / nm.served);
    nm.demand = demandEstimate(node, world);
    nm.capacity = node.control.type === 'signal' && node.control.signal?.cycle ? signalCapacities(node, world, (laneId) => laneSatFlow(world.lanes[laneId], world)) : unsignalisedCapacities(node, world, nm.demand);
  }
}

/** Gridlock meter and box-block tracking (every tick). */
export function updateGridlock(world: World, dt: number): void {
  let blockedNodes = 0;
  for (const node of Object.values(world.nodes)) {
    let blocked = false;
    for (const id of node.occupants) {
      const v = world.vehicles[id];
      if (v && v.place.kind === 'node' && v.speed < 0.3 && world.t - v.nodeEnterTime > 5) blocked = true;
    }
    if (blocked) {
      node.metrics.boxBlockedFor += dt;
      blockedNodes++;
    } else node.metrics.boxBlockedFor = 0;
  }
  // Lanes whose front vehicle has exhausted patience at the stop line also count (half weight).
  let starved = 0;
  for (const lane of Object.values(world.lanes)) {
    if (!lane.vehicles.length) continue;
    const v = world.vehicles[lane.vehicles[0]];
    if (v && v.patience <= 0 && v.speed < 0.3 && v.stopLineArrival > 0 && world.t - v.stopLineArrival > 90) starved++;
  }
  const pressure = blockedNodes + starved * 0.1;
  const m = world.metrics;
  if (pressure > 0) m.gridlock = Math.min(1, m.gridlock + world.config.gridlockFillPerSec * pressure * dt);
  else m.gridlock = Math.max(0, m.gridlock - world.config.gridlockDrainPerSec * dt);
  m.gridlockPeakToday = Math.max(m.gridlockPeakToday, m.gridlock);
  if (m.gridlock >= 1) world.gameOver = true;
}

/** Every minute: history sample, queue histories, prune recent trips. */
export function sampleMetrics(world: World): void {
  const m = world.metrics;
  const hourAgo = world.t - 3600;
  m.recent = m.recent.filter((r) => r.completedAt >= hourAgo);
  const people = m.recent.reduce((s, r) => s + r.people, 0);
  const delay = m.recent.length ? m.recent.reduce((s, r) => s + r.delay * r.people, 0) / Math.max(1, people) : 0;
  const window = Math.min(3600, Math.max(60, world.t));
  m.history.push({ t: world.t, flow: (people * 3600) / window, delay, gridlock: m.gridlock, vehicles: Object.keys(world.vehicles).length });
  if (m.history.length > 3 * 24 * 60) m.history.shift();
  for (const link of Object.values(world.links)) {
    for (const lane of allTrafficLanes(link)) {
      if (lane.type === 'bay') continue;
      let r = m.queueHistory[lane.id];
      if (!r) r = m.queueHistory[lane.id] = ringCreate(180);
      ringPush(r, queueLength(world, lane));
    }
  }
  // Worst approach delay (equity).
  let worst = 0;
  for (const node of Object.values(world.nodes)) if (node.metrics.served > 5) worst = Math.max(worst, node.metrics.delayAccum / node.metrics.served);
  m.worstApproachDelay = worst;
  // Link travel times decay toward free flow when unused.
  for (const link of Object.values(world.links)) link.travelTime += 0.05 * (link.freeFlowTime - link.travelTime);
}

export function currentFlowPerHour(world: World): number {
  const h = world.metrics.history;
  return h.length ? h[h.length - 1].flow : 0;
}

export function averageDelay(world: World): number {
  const h = world.metrics.history;
  return h.length ? h[h.length - 1].delay : 0;
}
