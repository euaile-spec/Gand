/** Trip completion and removal of vehicles from the world. */
import { removeFromArray } from '../core/util.js';
import type { Vehicle, World } from '../model/types.js';
import { removeFromLane } from './access.js';

/** Take a vehicle out of whatever lane/node it is in without finishing its trip. */
export function detachVehicle(world: World, v: Vehicle): void {
  const p = v.place;
  if (p.kind === 'lane') {
    const lane = world.lanes[p.laneId];
    if (lane) removeFromLane(world, lane, v);
  } else if (p.kind === 'node') {
    const node = world.nodes[p.nodeId];
    if (node) removeFromArray(node.occupants, v.id);
  } else if (p.kind === 'driveway') {
    const link = world.links[p.linkId];
    const dw = link?.driveways.find((d) => d.generatorId === p.generatorId);
    if (dw) removeFromArray(dw.exitQueue, v.id);
  }
  for (const road of Object.values(world.roads)) {
    for (const xo of road.crossovers) {
      removeFromArray(xo.waitingFwd, v.id);
      removeFromArray(xo.waitingBwd, v.id);
    }
  }
}

export function finishTrip(world: World, v: Vehicle): void {
  detachVehicle(world, v);
  const travel = world.t - v.spawnTime;
  const delay = Math.max(0, travel - v.freeFlowTime);
  const m = world.metrics;
  m.recent.push({ people: v.people, delay, travel, freeFlow: v.freeFlowTime, completedAt: world.t, cls: v.cls });
  m.peopleMoved += v.people;
  m.peopleDelaySeconds += v.people * delay;
  m.tripsCompleted += 1;
  // Score: people × closeness to free flow (floor 0.2 so volume still counts).
  const quality = Math.max(0.2, Math.min(1, v.freeFlowTime / Math.max(1, travel)));
  m.score += v.people * quality * 10;
  m.violations += v.violations;
  v.place = { kind: 'done' };
  delete world.vehicles[v.id];
}

/** Remove a vehicle without credit (e.g. despawned by an edit). */
export function discardVehicle(world: World, v: Vehicle): void {
  detachVehicle(world, v);
  delete world.vehicles[v.id];
}
