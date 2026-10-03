/** Run the playtest bot: `npx tsx src/cli/bot.ts [days] [seed] [--map=tutorial|radial|river] [--verbose] [--nobot]` */
import { Game } from '../game/game.js';
import { EngineerBot, summariseBot } from '../bot/engineer.js';
import { mapByName } from '../maps/index.js';
import { hourOfDay } from '../demand/profiles.js';
import { debugDump } from './debug.js';

const days = Number(process.argv[2] ?? 14);
const seed = Number(process.argv[3] ?? 1);
const mapName = process.argv.find((a) => a.startsWith('--map='))?.split('=')[1] ?? 'tutorial';
const verbose = process.argv.includes('--verbose');
const nobot = process.argv.includes('--nobot');
const disabled = (process.argv.find((a) => a.startsWith('--no='))?.split('=')[1] ?? '').split(',').filter(Boolean);

const g = new Game(mapByName(mapName)(), seed);
const bot = nobot ? null : new EngineerBot(g, { verbose, disabled });
const D = g.world.config.dayLength;
for (let d = 0; d < days && !g.world.gameOver; d++) {
  for (let s = 0; s < 48 && !g.world.gameOver; s++) {
    g.advance(D / 48);
    bot?.tick();
  }
  const h = g.hud();
  const m = g.world.metrics;
  console.log(`day ${g.world.day} flow=${h.peoplePerHour.toFixed(0)}/h delay=${h.avgDelay.toFixed(0)}s gridlockPeak=${m.gridlockPeakToday.toFixed(2)} people=${m.peopleMoved} crashes=${m.crashes} laneKm=${h.laneKm.toFixed(2)} tokens=${h.tokens} demand×${g.world.demandMultiplier.toFixed(2)} actions=${bot?.log.filter((a) => a.ok).length ?? 0}`);
}
if (g.world.gameOver) {
  console.log(`GAME OVER on day ${g.world.day} at h=${hourOfDay(g.world).toFixed(1)}`);
  debugDump(g.world);
}
if (bot) {
  console.log('bot actions:', JSON.stringify(summariseBot(bot)));
  const failed = bot.log.filter((a) => !a.ok);
  if (failed.length) console.log(`failed actions: ${failed.length} e.g. ${failed.slice(0, 3).map((a) => `${a.cmd.type}: ${a.error}`).join(' | ')}`);
}
