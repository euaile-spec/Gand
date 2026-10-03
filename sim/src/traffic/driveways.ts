/** Driveway exits: vehicles leave the generator's throat onto the street when a gap allows. */
import type { Driveway, Link, Vehicle, World } from '../model/types.js';
import { addToLane, neighboursAt, posOf, vehicleLength } from './access.js';
import { opposingGap } from './dynamics.js';
import { rerouteVehicle } from '../routing/routing.js';

export function throatCapacity(dw: Driveway): number {
  return Math.max(1, Math.floor(dw.throatLength / 6.5));
}

function rightOut(world: World, v: Vehicle, link: Link, dw: Driveway): boolean {
  const drivable = link.lanes.filter((l) => l.type === 'general');
  const lane = drivable[drivable.length - 1];
  if (!lane) return false;
  if (lane.blockedAt !== null && Math.abs(lane.blockedAt - dw.pos) < 10) return false;
  const { ahead, behind } = neighboursAt(world, lane, dw.pos, v.id);
  if (ahead && posOf(world, ahead.id) - vehicleLength(ahead) - dw.pos < 4) return false;
  if (behind) {
    const d = dw.pos - vehicleLength(v) - posOf(world, behind.id);
    if (d < 3 || d / Math.max(behind.speed, 0.5) < 2.5) return false;
  }
  addToLane(world, lane, v, dw.pos);
  return true;
}

function leftOut(world: World, v: Vehicle, link: Link, dw: Driveway): boolean {
  const road = world.roads[link.roadId];
  const rev = world.links[link.id.endsWith('>') ? `${road.id}<` : `${road.id}>`];
  if (!rev) return false;
  // Must cross the near lanes: no vehicle arriving at the driveway within 3 s.
  if (!opposingGap(world, link, dw.pos, 3.0)) return false;
  const landing = rev.length - dw.pos;
  const lane = rev.lanes.find((l) => l.type === 'general');
  if (!lane) return false;
  if (!opposingGap(world, rev, landing, 4.0)) return false;
  const { ahead } = neighboursAt(world, lane, landing, v.id);
  if (ahead && posOf(world, ahead.id) - vehicleLength(ahead) - landing < 4) return false;
  addToLane(world, lane, v, landing);
  return true;
}

export function processDrivewayExits(world: World, dt: number): void {
  for (const link of Object.values(world.links)) {
    for (const dw of link.driveways) {
      if (!dw.exitQueue.length) continue;
      const v = world.vehicles[dw.exitQueue[0]];
      if (!v) {
        dw.exitQueue.shift();
        continue;
      }
      // Delay accrues while waiting in the throat.
      for (const id of dw.exitQueue) {
        const w = world.vehicles[id];
        if (w) w.delay += dt;
      }
      const first = v.route[0];
      const ok = first === link.id ? rightOut(world, v, link, dw) : leftOut(world, v, link, dw);
      if (ok) {
        dw.exitQueue.shift();
        v.speed = 2;
        v.linkEnterT = world.t;
        v.waitStart = 0;
      } else if (v.waitStart === 0) v.waitStart = world.t;
      else if (world.t - v.waitStart > 60 && first !== link.id && dw.access === 'full') {
        // Give up on the left-out: switch to right-out and re-route from there.
        const rr = rerouteFromLink(world, v, link.id);
        if (rr) v.waitStart = world.t;
      }
    }
  }
}

function rerouteFromLink(world: World, v: Vehicle, linkId: string): boolean {
  v.route = [linkId];
  v.routeIdx = 0;
  return rerouteVehicle(world, v);
}
