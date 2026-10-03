/** Scenario definitions: a map, a brief, unlocks, and a goal evaluated against the world. */
import type { World } from '../model/types.js';
import type { MapDef } from '../network/mapdef.js';
import { tutorialMap } from '../maps/tutorial.js';
import { averageDelay } from '../metrics/metrics.js';

export interface Scenario {
  id: string;
  title: string;
  brief: string;
  map: () => MapDef;
  /** Keys in Resources.unlocks (or '*'). */
  unlocks: string[];
  deadlineDay: number;
  /** Returns progress 0..1 and whether the goal is met. */
  goal: (world: World) => { progress: number; met: boolean; label: string };
  startTimeOfDay?: number;
  config?: Partial<World['config']>;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'tut-1-signal',
    title: 'First Signal',
    brief: 'The centre intersection (n11) is uncontrolled and the arterial is backing up every morning. Put in a signal and get the average delay at n11 under 25 s through the AM peak.',
    map: tutorialMap,
    unlocks: ['signal', 'protected-left', 'pocket', 'right-on-red'],
    deadlineDay: 3,
    goal: (w) => {
      const n = w.nodes['n11'];
      const d = n.metrics.served > 20 ? n.metrics.delayAccum / n.metrics.served : 99;
      return { progress: Math.min(1, 25 / Math.max(1, d)), met: d < 25 && n.control.type === 'signal', label: `n11 delay ${d.toFixed(0)} s (target < 25)` };
    },
  },
  {
    id: 'tut-2-pocket',
    title: 'The Short Pocket',
    brief: 'Left turns from the arterial into the shops at n11 spill into the through lane. Add a left-turn pocket with enough storage and a protected phase. Keep the arterial through v/c under 0.9.',
    map: tutorialMap,
    unlocks: ['signal', 'protected-left', 'pocket', 'right-on-red', 'cycle'],
    deadlineDay: 3,
    goal: (w) => {
      const n = w.nodes['n11'];
      let worst = 0;
      for (const m of Object.values(n.movements)) {
        if (m.turn !== 'T') continue;
        const d = n.metrics.demand[m.key] ?? 0;
        const c = n.metrics.capacity[m.key] ?? 1;
        worst = Math.max(worst, d / Math.max(1, c));
      }
      const hasPocket = n.legs.some((l) => l.inLink && w.links[l.inLink].pocketLeft);
      return { progress: hasPocket ? Math.min(1, 0.9 / Math.max(0.01, worst)) : 0.2, met: hasPocket && worst < 0.9, label: `through v/c ${worst.toFixed(2)} (target < 0.9)` };
    },
  },
  {
    id: 'tut-3-people',
    title: 'Move People, Not Cars',
    brief: 'The bus route along the arterial is stuck in the same queue as everyone else. Give it a bus lane or priority and get the hourly people-flow above 400 without the gridlock meter passing 0.5.',
    map: tutorialMap,
    unlocks: ['*'],
    deadlineDay: 5,
    goal: (w) => {
      const h = w.metrics.history;
      const flow = h.length ? h[h.length - 1].flow : 0;
      return { progress: Math.min(1, flow / 400), met: flow > 400 && w.metrics.gridlockPeakToday < 0.5, label: `${flow.toFixed(0)} people/h (target > 400)` };
    },
  },
  {
    id: 'endless-tutorial',
    title: 'Endless: Tutorial City',
    brief: 'Survive as long as you can. Demand grows 6% a day.',
    map: tutorialMap,
    unlocks: ['*'],
    deadlineDay: Infinity,
    goal: (w) => ({ progress: Math.min(1, w.day / 30), met: false, label: `Day ${w.day} · avg delay ${averageDelay(w).toFixed(0)} s` }),
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
