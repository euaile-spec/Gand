/** Scheduled and random world events: stadium let-out, school pick-up, roadworks, parade, highway dump, rain. */
import { chance, nextInt, pick } from '../core/rng.js';
import type { WorldEvent, EventKind, World } from '../model/types.js';
import { recomputeBlockages } from './incidents.js';
import { rerouteVehicle } from '../routing/routing.js';

function addEvent(world: World, kind: EventKind, start: number, end: number, target: string | null): WorldEvent {
  const e: WorldEvent = { id: world.nextEventId++, kind, start, end, target, announced: false, applied: false, closedLanes: [] };
  world.events.push(e);
  return e;
}

/** Called at the start of each day to schedule that day's events. */
export function scheduleDailyEvents(world: World): void {
  const D = world.config.dayLength;
  const dayStart = world.day * D;
  // School pick-up every weekday-ish at 15:00.
  for (const g of Object.values(world.generators)) {
    if (g.kind === 'school' && g.active) addEvent(world, 'school-pickup', dayStart + 0.62 * D, dayStart + 0.66 * D, g.id);
    if (g.kind === 'stadium' && g.active && chance(world.rng, 0.4)) addEvent(world, 'stadium-letout', dayStart + 0.85 * D, dayStart + 0.9 * D, g.id);
  }
  // Roadworks: from week 2, 30% chance per day of a lane closed on a random road for a day.
  if (world.week >= 1 && chance(world.rng, 0.3)) {
    const roads = Object.values(world.roads).filter((r) => world.links[`${r.id}>`] && world.links[`${r.id}<`]);
    if (roads.length) addEvent(world, 'roadworks', dayStart + 0.3 * D, dayStart + 1.0 * D, pick(world.rng, roads).id);
  }
  if (world.day >= 6 && chance(world.rng, 0.1)) {
    const arterials = Object.values(world.roads).filter((r) => r.fwdLanes >= 2);
    if (arterials.length) addEvent(world, 'parade', dayStart + 0.55 * D, dayStart + 0.62 * D, pick(world.rng, arterials).id);
  }
  if (world.day >= 3 && chance(world.rng, 0.15)) addEvent(world, 'highway-dump', dayStart + 0.3 * D, dayStart + 0.4 * D, null);
  if (chance(world.rng, 0.2)) {
    const s = dayStart + (0.2 + 0.6 * (nextInt(world.rng, 100) / 100)) * D;
    addEvent(world, 'rain', s, s + 0.12 * D, null);
  }
  // New generators announce the day before they open.
  for (const g of Object.values(world.generators)) if (!g.active && g.opensDay === world.day + 1) addEvent(world, 'new-generator', dayStart + 0.5 * D, dayStart + 0.5 * D + 1, g.id);
}

export function updateEvents(world: World): void {
  let blockagesDirty = false;
  for (const e of world.events) {
    if (!e.applied && world.t >= e.start) {
      e.applied = true;
      switch (e.kind) {
        case 'stadium-letout': {
          const g = world.generators[e.target!];
          if (g) {
            g.surgeUntil = e.end;
            g.surgePeople = g.size * 20; // trips per hour extra while the surge lasts
          }
          break;
        }
        case 'school-pickup': {
          const g = world.generators[e.target!];
          if (g) {
            g.surgeUntil = e.end;
            g.surgePeople = g.size * 6;
            // Parent pick-up double-parking: block the curb lane near the school for the duration.
            const link = world.links[g.drivewayLink];
            const dw = link.driveways.find((d) => d.generatorId === g.id);
            const general = link.lanes.filter((l) => l.type === 'general');
            if (dw && general.length > 1 && !link.loadingZone) {
              e.closedLanes.push(general[general.length - 1].id);
              blockagesDirty = true;
            }
          }
          break;
        }
        case 'roadworks': {
          const road = world.roads[e.target!];
          const link = world.links[`${road.id}>`];
          const general = link?.lanes.filter((l) => l.type === 'general') ?? [];
          if (general.length) {
            e.closedLanes.push(general[general.length - 1].id);
            link.constructionUntil = e.end;
            blockagesDirty = true;
          }
          break;
        }
        case 'parade': {
          const road = world.roads[e.target!];
          for (const id of [`${road.id}>`, `${road.id}<`]) {
            const link = world.links[id];
            if (!link) continue;
            for (const l of link.lanes) if (l.type !== 'parking') e.closedLanes.push(l.id);
            link.constructionUntil = e.end;
          }
          blockagesDirty = true;
          break;
        }
        case 'highway-dump':
          for (const g of Object.values(world.generators)) {
            if (g.kind === 'external') {
              g.surgeUntil = e.end;
              g.surgePeople = g.size * 1.5;
            }
          }
          break;
        case 'rain':
          world.satFlowFactor = world.config.rainSatFlowFactor;
          break;
        case 'new-generator':
          break;
      }
    }
    if (e.applied && world.t >= e.end && e.end > 0) {
      // Expiry side effects.
      if (e.kind === 'rain') world.satFlowFactor = 1;
      if (e.closedLanes.length) {
        e.closedLanes = [];
        blockagesDirty = true;
      }
      if (e.kind === 'roadworks' || e.kind === 'parade') {
        for (const id of [`${e.target}>`, `${e.target}<`]) {
          const link = world.links[id];
          if (link && link.constructionUntil === e.end) link.constructionUntil = 0;
        }
      }
      e.end = -1; // mark done
    }
  }
  if (blockagesDirty) {
    recomputeBlockages(world);
    // Drivers learn of closures: re-route anyone whose route still uses a closed lane's link.
    const closedLinks = new Set<string>();
    for (const e of world.events) for (const id of e.closedLanes) closedLinks.add(world.lanes[id]?.linkId ?? '');
    for (const v of Object.values(world.vehicles)) {
      if (v.cyclic) continue;
      if (v.route.some((l, i) => i > v.routeIdx && closedLinks.has(l))) rerouteVehicle(world, v);
    }
  }
  // Prune old events.
  if (world.events.length > 200) world.events = world.events.filter((e) => e.end !== -1 || world.t - e.start < world.config.dayLength);
}

/** Events upcoming within the next in-game hour that have not been announced. */
export function pendingAnnouncements(world: World): WorldEvent[] {
  const soon = world.t + world.config.dayLength / 24;
  const out: WorldEvent[] = [];
  for (const e of world.events) {
    if (!e.announced && !e.applied && e.start <= soon) {
      e.announced = true;
      out.push(e);
    }
  }
  return out;
}
