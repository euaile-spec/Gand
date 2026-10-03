/** Headless runner: `npx tsx src/cli/run.ts [seconds] [seed] [--debug]` */
import { buildWorld } from '../network/build.js';
import { tutorialMap } from '../maps/tutorial.js';
import { tick } from '../game/tick.js';
import { hourOfDay } from '../demand/profiles.js';
import type { World } from '../model/types.js';
import { applyCommand } from '../editor/commands.js';
import { debugDump } from './debug.js';

const seconds = Number(process.argv[2] ?? 1800);
const seed = Number(process.argv[3] ?? 1);
const debug = process.argv.includes('--debug');

const growthArg = process.argv.find((a) => a.startsWith('--growth='));
const world = buildWorld(tutorialMap(), seed, growthArg ? { growthPerDay: Number(growthArg.split('=')[1]) } : {});
world.t = 0.3 * world.config.dayLength;
if (process.argv.includes('--signals')) {
  for (const id of ['n00', 'n01', 'n02', 'n10', 'n11', 'n12', 'n20', 'n21', 'n22']) applyCommand(world, { type: 'setControl', nodeId: id, control: 'signal' });
}

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
