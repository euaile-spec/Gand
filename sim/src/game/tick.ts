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

/** Peak-hour parking bans: the curb lane carries traffic during peaks and reverts when it empties. */
export function applyPeakParking(world: World): void {
  const peak = isPeakHour(timeOfDay(world));
  for (const link of Object.values(world.links)) {
    if (link.parking !== 'peak-ban') continue;
    const curb = link.lanes[link.lanes.length - 1];
    if (!curb) continue;
    if (peak && curb.type === 'parking') {
      curb.type = 'general';
      curb.peakLane = true;
      curb.width = 3.0;
      curb.allowed = ['T', 'R'];
    } else if (!peak && curb.peakLane) {
      // Nobody chooses it any more; it becomes parking again once the last vehicle has merged out.
      curb.allowed = [];
      if (curb.vehicles.length === 0) {
        curb.type = 'parking';
        curb.peakLane = false;
      }
    }
  }
}
