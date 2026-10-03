/**
 * Balancing harness: run N days with a scripted "engineer" that installs signals everywhere,
 * and print daily metrics. `npx tsx src/cli/balance.ts [days] [seed] [--signals] [--growth=1.06]`
 */
import { Game } from '../game/game.js';
import { tutorialMap } from '../maps/tutorial.js';
import { hourOfDay } from '../demand/profiles.js';
import { debugDump } from './debug.js';

const days = Number(process.argv[2] ?? 3);
const seed = Number(process.argv[3] ?? 1);
const signals = process.argv.includes('--signals');
const growthArg = process.argv.find((a) => a.startsWith('--growth='));
const growth = growthArg ? Number(growthArg.split('=')[1]) : undefined;

const g = new Game(tutorialMap(), seed, null, growth ? { growthPerDay: growth } : {});
if (signals) {
  for (const id of ['n00', 'n01', 'n02', 'n10', 'n11', 'n12', 'n20', 'n21', 'n22']) g.apply({ type: 'setControl', nodeId: id, control: 'signal' });
}
const D = g.world.config.dayLength;
let peakVeh = 0;
const samplesPerDay = 24;
for (let d = 0; d < days && !g.world.gameOver; d++) {
  for (let s = 0; s < samplesPerDay && !g.world.gameOver; s++) {
    g.advance(D / samplesPerDay);
    peakVeh = Math.max(peakVeh, Object.keys(g.world.vehicles).length);
  }
  const h = g.hud();
  const m = g.world.metrics;
  console.log(
    `day ${g.world.day} h=${hourOfDay(g.world).toFixed(1)} veh=${h.vehicles} peakVeh=${peakVeh} flow=${h.peoplePerHour.toFixed(0)}/h delay=${h.avgDelay.toFixed(1)}s gridlockPeak=${m.gridlockPeakToday.toFixed(2)} trips=${m.tripsCompleted} people=${m.peopleMoved} lost=${m.lostTrips} crashes=${m.crashes} score=${h.score} laneKm=${h.laneKm.toFixed(2)} demand×${g.world.demandMultiplier.toFixed(2)}`,
  );
  peakVeh = 0;
}
if (g.world.gameOver) {
  console.log(`GAME OVER on day ${g.world.day} at h=${hourOfDay(g.world).toFixed(1)}`);
  debugDump(g.world);
}
