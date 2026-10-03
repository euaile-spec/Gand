/**
 * Multi-seed survival table: maps × seeds × {none, bot}.
 * `npx tsx src/cli/multi.ts [days] [--seeds=3] [--maps=tutorial,radial,river]`
 */
import { Game } from '../game/game.js';
import { EngineerBot } from '../bot/engineer.js';
import { MAPS, mapByName } from '../maps/index.js';

const days = Number(process.argv[2] ?? 14);
const seeds = Number(process.argv.find((a) => a.startsWith('--seeds='))?.split('=')[1] ?? 3);
const mapNames = (process.argv.find((a) => a.startsWith('--maps='))?.split('=')[1] ?? Object.keys(MAPS).join(',')).split(',');

interface Row {
  map: string;
  seed: number;
  policy: string;
  died: number | null;
  peakFlow: number;
  people: number;
  actions: number;
}

function run(map: string, seed: number, useBot: boolean): Row {
  const g = new Game(mapByName(map)(), seed);
  const bot = useBot ? new EngineerBot(g) : null;
  const D = g.world.config.dayLength;
  let peakFlow = 0;
  for (let d = 0; d < days && !g.world.gameOver; d++) {
    for (let s = 0; s < 48 && !g.world.gameOver; s++) {
      g.advance(D / 48);
      bot?.tick();
      peakFlow = Math.max(peakFlow, g.hud().peoplePerHour);
    }
  }
  return { map, seed, policy: useBot ? 'bot' : 'none', died: g.world.gameOver ? g.world.day : null, peakFlow, people: g.world.metrics.peopleMoved, actions: bot?.log.filter((a) => a.ok).length ?? 0 };
}

const rows: Row[] = [];
for (const map of mapNames) {
  for (let seed = 1; seed <= seeds; seed++) {
    for (const useBot of [false, true]) {
      const r = run(map, seed, useBot);
      rows.push(r);
      console.log(`${r.map.padEnd(9)} seed ${r.seed} ${r.policy.padEnd(4)} ${r.died === null ? `survived ${days}d` : `died day ${r.died}`.padEnd(12)} peak ${r.peakFlow.toFixed(0).padStart(5)}/h people ${String(r.people).padStart(6)} actions ${r.actions}`);
    }
  }
}
console.log('\nsummary (mean death day; survivors count as days+1)');
for (const map of mapNames) {
  for (const policy of ['none', 'bot']) {
    const rs = rows.filter((r) => r.map === map && r.policy === policy);
    const mean = rs.reduce((s, r) => s + (r.died ?? days + 1), 0) / rs.length;
    const flow = rs.reduce((s, r) => s + r.peakFlow, 0) / rs.length;
    console.log(`${map.padEnd(9)} ${policy.padEnd(4)} meanDeath=${mean.toFixed(1)} meanPeakFlow=${flow.toFixed(0)}`);
  }
}
