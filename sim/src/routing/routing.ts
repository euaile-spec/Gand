/**
 * Time-dependent shortest paths over the link graph. Edge = movement at the downstream node
 * (or a mid-block U-turn at a median crossover). Costs use observed link travel times,
 * expected control delay per movement, a stop penalty and a perceived penalty for unprotected lefts.
 */
import type { LinkId, Movement, SimNode, Vehicle, VehicleClass, World } from '../model/types.js';
import { lanesAllowing } from '../network/lanes.js';

export interface RouteOptions {
  cls: VehicleClass;
  /** Multiplier applied to a link's cost (VMS steering). */
  avoid?: { link: LinkId; mult: number } | null;
  /** Allowed final links (destination driveway reachability). */
  destLinks: LinkId[];
  /** Fraction of the origin link already travelled (0..1). */
  originFraction?: number;
}

interface Edge {
  to: LinkId;
  cost: number;
}

/** Expected delay for using a movement, from observed node metrics or control-based defaults. */
export function movementCost(world: World, node: SimNode, m: Movement): number {
  const c = node.control;
  let base: number;
  switch (c.type) {
    case 'signal': {
      const plan = c.signal;
      if (plan && plan.cycle > 0) {
        let g = 0;
        for (const p of plan.phases) if (p.movements.includes(m.key)) g += p.split;
        const r = Math.max(0, plan.cycle - g);
        base = plan.cycle > 0 ? (r * r) / (2 * plan.cycle) : 20; // uniform delay, d1
        if (m.turn === 'L' && (plan.leftTreatment[m.fromLink] ?? 'permitted') === 'permitted') base += 10;
      } else base = 25;
      break;
    }
    case 'all-way-stop':
      base = 12;
      break;
    case 'two-way-stop':
      base = c.minorLinks.includes(m.fromLink) ? 14 : m.turn === 'L' ? 6 : 1;
      break;
    case 'yield':
      base = c.minorLinks.includes(m.fromLink) ? 8 : m.turn === 'L' ? 5 : 1;
      break;
    case 'roundabout':
      base = 6;
      break;
    default:
      base = m.turn === 'L' || m.turn === 'U' ? 8 : m.turn === 'R' ? 3 : 2;
  }
  // Observed v/c pushes drivers away from saturated movements.
  const d = node.metrics.demand[m.key] ?? 0;
  const cap = node.metrics.capacity[m.key] ?? 0;
  if (cap > 0 && d > 0) {
    const x = d / cap;
    if (x > 0.8) base += Math.min(120, 40 * (x - 0.8) * 5);
  }
  if (m.turn === 'L' || m.turn === 'U') base += 4; // perceived discomfort
  return base + m.length / Math.max(1, m.speed);
}

function edges(world: World, from: LinkId, opts: RouteOptions): Edge[] {
  const link = world.links[from];
  const out: Edge[] = [];
  if (!link) return out;
  const node = world.nodes[link.to];
  const mult = opts.avoid && opts.avoid.link === from ? opts.avoid.mult : 1;
  const linkCost = link.travelTime * mult + (link.constructionUntil > world.t ? 30 : 0);
  if (node) {
    for (const m of Object.values(node.movements)) {
      if (m.fromLink !== from) continue;
      if (node.banned.includes(m.key)) continue;
      const toLink = world.links[m.toLink];
      if (!toLink) continue;
      if (!lanesAllowing(link, m.turn, opts.cls).length) continue;
      // Trucks can't make tight right turns.
      if ((opts.cls === 'truck' || opts.cls === 'bus') && m.turn === 'R') {
        const leg = node.legs.find((l) => l.leg === m.entryLeg);
        if (leg?.cornerRadius === 'tight') continue;
      }
      out.push({ to: m.toLink, cost: linkCost + movementCost(world, node, m) });
    }
  }
  // Mid-block U-turn via a crossover onto the reverse link.
  const road = world.roads[link.roadId];
  const rev = from.endsWith('>') ? `${road.id}<` : `${road.id}>`;
  if (world.links[rev]) {
    for (const xo of road.crossovers) {
      if (xo.kind !== 'uturn') continue;
      const fwd = from.endsWith('>');
      if ((fwd && !xo.fwd) || (!fwd && !xo.bwd)) continue;
      const frac = fwd ? xo.pos / road.length : (road.length - xo.pos) / road.length;
      out.push({ to: rev, cost: link.travelTime * frac * mult + 12 + (xo.signalised ? 8 : 0) + (world.links[rev].travelTime * (1 - frac)) });
    }
  }
  return out;
}

/** Binary-heap Dijkstra. Returns link sequence from `origin` to one of `opts.destLinks`, or null. */
export function shortestPath(world: World, origin: LinkId, opts: RouteOptions): LinkId[] | null {
  const dest = new Set(opts.destLinks);
  if (dest.has(origin) && (opts.originFraction ?? 0) <= 0.999) {
    // Already on the destination link; only valid if the driveway is ahead — the caller checks.
  }
  const distMap = new Map<LinkId, number>();
  const prev = new Map<LinkId, LinkId>();
  const heap: { id: LinkId; d: number }[] = [];
  const push = (id: LinkId, d: number): void => {
    heap.push({ id, d });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].d <= heap[i].d) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): { id: LinkId; d: number } | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heap.length && heap[l].d < heap[s].d) s = l;
        if (r < heap.length && heap[r].d < heap[s].d) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]];
        i = s;
      }
    }
    return top;
  };
  const startCost = -(world.links[origin]?.travelTime ?? 0) * (opts.originFraction ?? 0);
  distMap.set(origin, startCost);
  push(origin, startCost);
  let found: LinkId | null = null;
  while (heap.length) {
    const cur = pop()!;
    if (cur.d > (distMap.get(cur.id) ?? Infinity)) continue;
    if (dest.has(cur.id) && cur.id !== origin) {
      found = cur.id;
      break;
    }
    if (dest.has(cur.id) && cur.id === origin && (opts.originFraction ?? 0) < 0) {
      found = cur.id;
      break;
    }
    for (const e of edges(world, cur.id, opts)) {
      const nd = cur.d + e.cost;
      if (nd < (distMap.get(e.to) ?? Infinity)) {
        distMap.set(e.to, nd);
        prev.set(e.to, cur.id);
        push(e.to, nd);
      }
    }
  }
  if (!found) return null;
  const path: LinkId[] = [found];
  while (path[0] !== origin) {
    const p = prev.get(path[0]);
    if (!p) return null;
    path.unshift(p);
  }
  return path;
}

/** Destination links for a generator: its driveway link, plus the reverse link when left-in is allowed. */
export function destinationLinks(world: World, generatorId: string): LinkId[] {
  const gen = world.generators[generatorId];
  const link = world.links[gen.drivewayLink];
  const dw = link.driveways.find((d) => d.generatorId === generatorId);
  const out: LinkId[] = [link.id];
  if (dw && dw.access === 'full') {
    const road = world.roads[link.roadId];
    const rev = link.id.endsWith('>') ? `${road.id}<` : `${road.id}>`;
    const revLink = world.links[rev];
    if (revLink && road.median !== 'closed' && !revLink.noLeftIntoDriveways) out.push(rev);
  }
  return out;
}

/** Origin links for a generator (right-out always; left-out if full access and a reverse link exists). */
export function originLinks(world: World, generatorId: string): LinkId[] {
  return destinationLinks(world, generatorId);
}

/**
 * Re-route a vehicle from its current link. Keeps the current link as route[0] and
 * recomputes the rest. Returns false if no route exists.
 */
export function rerouteVehicle(world: World, v: Vehicle, avoid: RouteOptions['avoid'] = null): boolean {
  if (v.cyclic || !v.destGen) return false;
  const cur = v.route[v.routeIdx];
  if (!cur) return false;
  const link = world.links[cur];
  const frac = v.place.kind === 'lane' ? v.place.pos / link.length : 1;
  const dests = destinationLinks(world, v.destGen);
  // If we're already on a destination link with the driveway ahead, no reroute needed.
  const gen = world.generators[v.destGen];
  const dw = world.links[gen.drivewayLink].driveways.find((d) => d.generatorId === gen.id)!;
  for (const d of dests) {
    if (d !== cur) continue;
    const pos = d === gen.drivewayLink ? dw.pos : link.length - dw.pos;
    if (v.place.kind !== 'lane' || v.place.pos < pos - 5) {
      v.route = [cur];
      v.routeIdx = 0;
      v.destPos = pos;
      return true;
    }
  }
  const path = shortestPath(world, cur, { cls: v.cls, destLinks: dests, avoid, originFraction: frac });
  if (!path) return false;
  v.route = path;
  v.routeIdx = 0;
  const last = path[path.length - 1];
  v.destPos = last === gen.drivewayLink ? dw.pos : world.links[last].length - dw.pos;
  return true;
}

/** Free-flow travel time of a route (for delay accounting). */
export function routeFreeFlow(world: World, route: LinkId[], startFrac: number, endPos: number | null): number {
  let t = 0;
  route.forEach((id, i) => {
    const l = world.links[id];
    if (!l) return;
    let len = l.length;
    if (i === 0) len -= startFrac * l.length;
    if (i === route.length - 1 && endPos !== null) len = Math.max(0, Math.min(len, endPos - (i === 0 ? startFrac * l.length : 0)));
    t += len / l.speedLimit;
    if (i < route.length - 1) t += 3; // nominal turn time
  });
  return t;
}
