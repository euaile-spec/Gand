/** Headless runner: `npx tsx src/cli/run.ts [seconds] [seed] [--debug]` */
import { buildWorld } from '../network/build.js';
import { tutorialMap } from '../maps/tutorial.js';
import { tick } from '../game/tick.js';
import { hourOfDay } from '../demand/profiles.js';
import type { World } from '../model/types.js';
import { nextMovement } from '../traffic/access.js';
import { approachingVehicles, mayEnter, viewFor } from '../control/manager.js';

const seconds = Number(process.argv[2] ?? 1800);
const seed = Number(process.argv[3] ?? 1);
const debug = process.argv.includes('--debug');

const world = buildWorld(tutorialMap(), seed);
world.t = 0.3 * world.config.dayLength;

function report(w: World): void {
  const m = w.metrics;
  const vehicles = Object.values(w.vehicles);
  const stopped = vehicles.filter((v) => v.speed < 0.3).length;
  const inNode = vehicles.filter((v) => v.place.kind === 'node').length;
  const last = m.history[m.history.length - 1];
  console.log(
    `t=${w.t.toFixed(0)} h=${hourOfDay(w).toFixed(2)} veh=${vehicles.length} stopped=${stopped} inNode=${inNode} trips=${m.tripsCompleted} people=${m.peopleMoved} flow/h=${last?.flow.toFixed(0) ?? '-'} delay=${last?.delay.toFixed(1) ?? '-'} gridlock=${m.gridlock.toFixed(2)} lost=${m.lostTrips} crashes=${m.crashes}`,
  );
}

function debugDump(w: World): void {
  for (const node of Object.values(w.nodes)) {
    const occ = node.occupants.map((id) => w.vehicles[id]).filter(Boolean);
    const stuck = occ.filter((v) => v.speed < 0.3 && w.t - v.nodeEnterTime > 5);
    if (stuck.length) console.log(`  node ${node.id} box-blocked: ${stuck.map((v) => `${v.id}@${v.place.kind === 'node' ? v.place.movement : ''} pos=${(v.place as { pos: number }).pos.toFixed(1)}`).join(', ')}`);
  }
  for (const lane of Object.values(w.lanes)) {
    if (!lane.vehicles.length) continue;
    const front = w.vehicles[lane.vehicles[0]];
    const link = w.links[lane.linkId];
    if (front && front.speed < 0.3 && front.place.kind === 'lane') {
      const node = w.nodes[link.to];
      const m = nextMovement(w, front);
      const dec = m ? mayEnter(w, node, front, m, approachingVehicles(w, node), viewFor(node, w)) : null;
      console.log(
        `  lane ${lane.id} front ${front.id} pos=${front.place.pos.toFixed(1)}/${link.length.toFixed(0)} wait=${front.stopLineArrival ? (w.t - front.stopLineArrival).toFixed(0) : '-'}s route ${front.route.slice(front.routeIdx, front.routeIdx + 2).join('→')} turn=${m?.turn ?? '-'} allowed=${lane.allowed.join('')} q=${lane.vehicles.length} pat=${front.patience.toFixed(2)} dest=${front.destPos?.toFixed(0) ?? '-'} dec=${dec ? (dec.go ? 'go' : dec.reason) : 'none'} ctrl=${node.control.type}`,
      );
    }
  }
}

const steps = Math.round(seconds / world.config.tickDt);
for (let i = 0; i < steps; i++) {
  tick(world);
  if (i % Math.round(300 / world.config.tickDt) === 0) {
    report(world);
    if (debug) debugDump(world);
  }
  if (world.gameOver) {
    console.log('GAME OVER');
    report(world);
    debugDump(world);
    break;
  }
}
report(world);
