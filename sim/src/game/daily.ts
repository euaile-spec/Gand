/** Daily challenge: a date-seeded procedural city, ten in-game days, fixed allotment, score on the leaderboard. */
import type { Scenario } from './scenarios.js';
import { Game } from './game.js';
import { hashString, proceduralMap } from '../maps/procedural.js';
import { averageDelay } from '../metrics/metrics.js';

export const DAILY_DAYS = 10;

/** YYYY-MM-DD in UTC for "today", or the given date. */
export function dailyKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function dailySeed(key: string): number {
  return hashString(`gand-daily-${key}`);
}

export function dailyScenario(key: string = dailyKey()): Scenario {
  const seed = dailySeed(key);
  return {
    id: `daily-${key}`,
    title: `Daily Challenge ${key}`,
    teaches: 'Everything, against the clock',
    brief: `A fresh city, the same for everyone today. Ten days, 1.0 lane-km a week, one token-or-lanes choice a week. Score is people moved weighted by how close to free-flow they travelled.`,
    map: () => proceduralMap(seed),
    unlocks: ['*'],
    deadlineDay: DAILY_DAYS,
    goal: (w) => {
      const done = w.day >= DAILY_DAYS || w.gameOver;
      return { progress: Math.min(1, w.day / DAILY_DAYS), met: done && !w.gameOver, label: `Day ${w.day}/${DAILY_DAYS} · score ${Math.round(w.metrics.score)} · delay ${averageDelay(w).toFixed(0)} s` };
    },
  };
}

/** The daily game: deterministic for everyone who plays the same date. */
export function dailyGame(key: string = dailyKey()): Game {
  return Game.fromScenario(dailyScenario(key), dailySeed(key));
}

/** Final score once the run is over (game over or day limit reached); null while still running. */
export function dailyResult(game: Game): { score: number; survived: boolean; day: number } | null {
  const w = game.world;
  if (!(w.gameOver || w.day >= DAILY_DAYS)) return null;
  return { score: Math.round(w.metrics.score), survived: !w.gameOver, day: w.day };
}
