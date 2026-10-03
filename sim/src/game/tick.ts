/** One simulation tick, and the day/week transitions. */
import type { World } from '../model/types.js';
import { updateSignal } from '../control/signal.js';
import { generateDemand, dispatchBuses } from '../demand/spawn.js';
import { isPeakHour, timeOfDay } from '../demand/profiles.js';
import { onNewWeek } from '../economy/resources.js';
import { completeConstructions } from '../economy/construction.js';
import { expireIncidents, refreshConflictScores, rollIncidents } from '../incidents/incidents.js';
import { scheduleDailyEvents, updateEvents } from '../incidents/events.js';
import { refreshNodeMetrics, sampleMetrics, updateGridlock } from '../metrics/metrics.js';
import { processDrivewayExits } from '../traffic/driveways.js';
import { stepCrossovers, stepVehicles } from '../traffic/dynamics.js';
import { updatePedestrians } from '../traffic/pedestrians.js';
import { defaultAllowed } from '../network/lanes.js';

export function tick(world: World): void {
  const dt = world.config.tickDt;
  const before = world.t;
  world.t += dt;

  // Day / week boundaries.
  const D = world.config.dayLength;
  if (Math.floor(world.t / D) > Math.floor(before / D)) onNewDay(world);

  // Minute boundary housekeeping.
  if (Math.floor(world.t / 60) > Math.floor(before / 60)) {
    refreshNodeMetrics(world);
    refreshConflictScores(world);
    sampleMetrics(world);
    applyPeakParking(world);
  }

  updateEvents(world);
  expireIncidents(world);
  completeConstructions(world);

  generateDemand(world, dt);
  dispatchBuses(world);

  for (const node of Object.values(world.nodes)) if (node.control.type === 'signal') updateSignal(node, world, dt);

  updatePedestrians(world, dt);
  processDrivewayExits(world, dt);
  stepCrossovers(world, dt);
  stepVehicles(world, dt);

  rollIncidents(world, dt);
  updateGridlock(world, dt);
}

export function onNewDay(world: World): void {
  world.day += 1;
  world.demandMultiplier *= world.config.growthPerDay;
  world.metrics.gridlockPeakToday = 0;
  for (const g of Object.values(world.generators)) {
    if (!g.active && g.opensDay <= world.day) {
      g.active = true;
      // The new generator pays for its own access.
      world.resources.laneKm += 0.2;
    }
  }
  if (world.day % world.config.daysPerWeek === 0) {
    world.week += 1;
    onNewWeek(world);
  }
  scheduleDailyEvents(world);
}

/** Peak-hour parking bans: the parking lane becomes a travel lane during peaks. */
export function applyPeakParking(world: World): void {
  const peak = isPeakHour(timeOfDay(world));
  for (const link of Object.values(world.links)) {
    if (link.parking !== 'peak-ban') continue;
    const lane = link.lanes.find((l) => l.index === link.lanes.filter((x) => x.type !== 'parking' || x === l).length - 1 && (l.type === 'parking' || l.width < 3.2));
    const target = link.lanes[link.lanes.length - 1];
    if (!target) continue;
    if (peak && target.type === 'parking') {
      target.type = 'general';
      target.width = 3.0;
      const n = link.lanes.filter((l) => l.type === 'general').length;
      target.allowed = defaultAllowed(n, n - 1);
      // The former rightmost lane loses its right-turn exclusivity.
      const prev = link.lanes.filter((l) => l.type === 'general')[n - 2];
      if (prev && n > 1) prev.allowed = defaultAllowed(n, n - 2);
    } else if (!peak && target.type === 'general' && target.width <= 3.0 && lane === target) {
      target.type = 'parking';
      target.allowed = [];
      const general = link.lanes.filter((l) => l.type === 'general');
      general.forEach((l, i) => (l.allowed = l.allowed.length ? l.allowed : defaultAllowed(general.length, i)));
      const last = general[general.length - 1];
      if (last && !last.allowed.includes('R')) last.allowed = [...last.allowed, 'R'];
    }
  }
}
