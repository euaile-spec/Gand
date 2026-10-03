/** Pedestrian demand at node crosswalks and mid-block crossings. */
import { poissonEvent } from '../core/rng.js';
import { dist } from '../core/util.js';
import { PED_WALK_SPEED, type SimNode, type World } from '../model/types.js';
import { conflictBetween } from '../network/geometry.js';
import { signalView } from '../control/signal.js';
import { approachingVehicles } from '../control/manager.js';
import { timeOfDay } from '../demand/profiles.js';

/** Pedestrian arrival rate (persons/hour) at a node from nearby land use and bus stops. */
export function pedRateAtNode(world: World, node: SimNode): number {
  let rate = 0;
  for (const g of Object.values(world.generators)) {
    if (!g.active) continue;
    const d = dist(g.pos, node.pos);
    if (d < 250) rate += g.size * (g.kind === 'external' ? 0 : g.kind === 'school' ? 3 : g.kind === 'shop' ? 2.2 : 1.2) * (1 - d / 250) * g.walkability;
  }
  for (const stop of Object.values(world.busStops)) {
    const link = world.links[stop.linkId];
    const near = link.to === node.id ? link.length - stop.pos : link.from === node.id ? stop.pos : Infinity;
    if (near < 80) rate += 20;
  }
  return rate * 0.35 * world.demandMultiplier * pedProfile(timeOfDay(world));
}

function pedProfile(tod: number): number {
  // Peaks at AM commute, lunch, school out, PM.
  const bump = (c: number, w: number, h: number): number => h * Math.exp(-((tod - c) * (tod - c)) / (2 * w * w));
  return 0.3 + bump(0.33, 0.04, 1) + bump(0.5, 0.05, 0.8) + bump(0.62, 0.03, 1.1) + bump(0.72, 0.05, 1);
}

export function updatePedestrians(world: World, dt: number): void {
  for (const node of Object.values(world.nodes)) {
    const crossings = Object.values(node.peds).filter((p) => p.enabled);
    if (!crossings.length) continue;
    const ratePerSec = pedRateAtNode(world, node) / 3600 / crossings.length;
    const sig = node.control.type === 'signal' ? signalView(node, world) : null;
    let approaching: ReturnType<typeof approachingVehicles> | null = null;
    for (const p of crossings) {
      if (poissonEvent(world.rng, ratePerSec, dt)) {
        // Join a crossing that just started rather than queueing for a new gap.
        if (p.crossingUntil > world.t + p.width / PED_WALK_SPEED - 4) p.served += 1;
        else p.waiting += 1;
      }
      if (p.waiting > 0) {
        p.delayAccum += p.waiting * dt;
        world.metrics.pedDelaySeconds += p.waiting * dt;
      }
      if (p.waiting === 0) continue;
      if (sig) {
        if (sig.walk(p.key)) {
          p.served += p.waiting;
          p.waiting = 0;
          p.crossingUntil = Math.max(p.crossingUntil, world.t + p.width / PED_WALK_SPEED);
        }
        continue;
      }
      // Unsignalised: cross when no conflicting vehicle is within 3 s or inside the node on a conflicting path.
      approaching ??= approachingVehicles(world, node, 4);
      let safe = true;
      for (const a of approaching) {
        if (conflictBetween(node, a.movement.key, p.key) !== 'none' && a.tta < 3 && a.v.speed > 1) {
          safe = false;
          break;
        }
      }
      if (safe) {
        for (const id of node.occupants) {
          const o = world.vehicles[id];
          if (o.place.kind === 'node' && conflictBetween(node, o.place.movement, p.key) !== 'none') {
            safe = false;
            break;
          }
        }
      }
      // Patience: after 30 s of waiting pedestrians step out anyway (vehicles must yield).
      if (safe || p.delayAccum / Math.max(1, p.waiting) > 30) {
        p.served += p.waiting;
        p.waiting = 0;
        p.crossingUntil = world.t + p.width / PED_WALK_SPEED;
      }
    }
  }
  // Mid-block crossings
  for (const link of Object.values(world.links)) {
    for (const c of link.crossings) {
      const rate = (c.demandPerHour * world.demandMultiplier * pedProfile(timeOfDay(world))) / 3600;
      if (poissonEvent(world.rng, rate, dt)) c.waiting += 1;
      if (c.waiting > 0) world.metrics.pedDelaySeconds += c.waiting * dt;
      if (c.waiting === 0 || c.activeUntil > world.t) continue;
      const width = link.lanes.length * 3.5 * 2;
      if (c.signalised) {
        // Actuated ped signal: fires after a short delay, holds vehicles for the crossing time.
        if (world.t % 20 < dt) {
          c.activeUntil = world.t + width / PED_WALK_SPEED + 3;
          c.waiting = 0;
        }
      } else {
        // Vehicles yield when a pedestrian is waiting; the crossing takes width / speed.
        c.activeUntil = world.t + width / PED_WALK_SPEED;
        c.waiting = 0;
      }
    }
  }
}
