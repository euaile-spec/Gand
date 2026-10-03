import { describe, expect, it } from 'vitest';
import { buildWorld } from '../src/network/build.js';
import { tutorialMap } from '../src/maps/tutorial.js';
import { tick } from '../src/game/tick.js';

function run(world: ReturnType<typeof buildWorld>, seconds: number): void {
  const n = Math.round(seconds / world.config.tickDt);
  for (let i = 0; i < n; i++) tick(world);
}

describe('smoke', () => {
  it('runs a tenth of a day and completes trips', () => {
    const w = buildWorld(tutorialMap(), 42);
    // Start at the AM peak so traffic appears quickly.
    w.t = 0.3 * w.config.dayLength;
    run(w, 600);
    const vehicles = Object.keys(w.vehicles).length;
    expect(vehicles).toBeGreaterThan(0);
    expect(w.metrics.tripsCompleted).toBeGreaterThan(0);
    expect(w.gameOver).toBe(false);
    // Vehicles are consistently indexed in lanes.
    for (const lane of Object.values(w.lanes)) {
      for (const id of lane.vehicles) {
        const v = w.vehicles[id];
        expect(v).toBeDefined();
        expect(v.place.kind).toBe('lane');
        if (v.place.kind === 'lane') expect(v.place.laneId).toBe(lane.id);
      }
    }
    for (const node of Object.values(w.nodes)) {
      for (const id of node.occupants) {
        const v = w.vehicles[id];
        expect(v).toBeDefined();
        expect(v.place.kind).toBe('node');
      }
    }
  });
});
