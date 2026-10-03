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

const baseArg = process.argv.find((a) => a.startsWith('--base='));
const overrides: Record<string, number> = {};
if (growth) overrides.growthPerDay = growth;
if (baseArg) overrides.baseTripsPerHourPerSize = Number(baseArg.split('=')[1]);
const g = new Game(tutorialMap(), seed, null, overrides);
if (signals) {
  for (const id of ['n00', 'n01', 'n02', 'n10', 'n11', 'n12', 'n20', 'n21', 'n22']) g.apply({ type: 'setControl', nodeId: id, control: 'signal' });
}
if (process.argv.includes('--stops')) {
  for (const id of ['n00', 'n01', 'n02', 'n10', 'n11', 'n12', 'n20', 'n21', 'n22']) g.apply({ type: 'setControl', nodeId: id, control: 'two-way-stop' });
}
if (process.argv.includes('--smart')) {
  // A competent plan: signals on the arterial with protected lefts and pockets, two-way stops elsewhere.
  g.world.resources.laneKm = 5;
  for (const id of ['n10', 'n11', 'n12']) {
    const node = g.world.nodes[id];
    for (const leg of node.legs) {
      if (!leg.inLink) continue;
      const link = g.world.links[leg.inLink];
      if (link.lanes.filter((l) => l.type === 'general').length < 2) continue;
      const road = g.world.roads[link.roadId];
      const r = g.apply({ type: 'setPocket', linkId: link.id, spec: { side: 'left', storage: 60, source: road.median !== 'none' ? 'median' : 'narrow' } });
      if (!r.ok) console.log('pocket failed', link.id, r.error);
    }
    if (process.argv.includes('--slip')) for (const leg of node.legs) if (leg.inLink) g.apply({ type: 'setChannelisedRight', nodeId: id, leg: leg.leg, on: true });
    g.apply({ type: 'setControl', nodeId: id, control: 'signal' });
    const noprot = process.argv.includes('--noprot');
    for (const leg of node.legs) {
      if (!leg.inLink) continue;
      const link = g.world.links[leg.inLink];
      if (link.pocketLeft && !noprot) g.apply({ type: 'setLeftTreatment', nodeId: id, linkId: link.id, treatment: 'protected-permitted' });
    }
    const cycleArg = process.argv.find((a) => a.startsWith('--cycle='));
    g.apply({ type: 'setCycle', nodeId: id, cycle: cycleArg ? Number(cycleArg.split('=')[1]) : 70 });
    if (process.argv.includes('--actuated')) {
      g.apply({ type: 'setActuated', nodeId: id, on: true });
      const dets: { laneId: string; setback: number }[] = [];
      for (const leg of node.legs) {
        if (!leg.inLink) continue;
        for (const lane of g.world.links[leg.inLink].lanes) if (lane.type === 'general') dets.push({ laneId: lane.id, setback: 0 }, { laneId: lane.id, setback: 80 });
      }
      g.apply({ type: 'setDetectors', nodeId: id, detectors: dets });
    }
  }
  for (const id of ['n00', 'n01', 'n02', 'n20', 'n21', 'n22']) g.apply({ type: 'setControl', nodeId: id, control: process.argv.includes('--awsc') ? 'all-way-stop' : 'two-way-stop' });
  const plan = g.world.nodes['n11'].control.signal!;
  console.log('n11 plan:', plan.phases.map((p) => `[${p.movements.map((m) => m.split(':')[1] + m.split(':')[0].slice(-3)).join(' ')}] ${p.split.toFixed(0)}s`).join(' | '), 'cycle', plan.cycle.toFixed(0));
}
const D = g.world.config.dayLength;
let peakVeh = 0;
const samplesPerDay = 24;
for (let d = 0; d < days && !g.world.gameOver; d++) {
  for (let s = 0; s < samplesPerDay && !g.world.gameOver; s++) {
    g.advance(D / samplesPerDay);
    peakVeh = Math.max(peakVeh, Object.keys(g.world.vehicles).length);
    if (process.argv.includes('--hourly')) console.log(`   h=${hourOfDay(g.world).toFixed(0)} veh=${Object.keys(g.world.vehicles).length} gridlock=${g.world.metrics.gridlock.toFixed(2)} flow=${g.hud().peoplePerHour.toFixed(0)} delay=${g.hud().avgDelay.toFixed(0)}`);
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
