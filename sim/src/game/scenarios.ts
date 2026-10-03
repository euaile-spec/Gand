/** Scenario definitions: a map, a brief, unlocks, an optional setup, and a goal evaluated against the world. */
import type { World } from '../model/types.js';
import type { MapDef } from '../network/mapdef.js';
import type { Game } from './game.js';
import { tutorialMap } from '../maps/tutorial.js';
import { radialMap } from '../maps/radial.js';
import { riverMap } from '../maps/river.js';
import { averageDelay } from '../metrics/metrics.js';
import { scheduleEvent } from '../incidents/events.js';

export interface Scenario {
  id: string;
  title: string;
  /** One concept per scenario. */
  teaches: string;
  brief: string;
  map: () => MapDef;
  /** Keys in Resources.unlocks (or '*'). */
  unlocks: string[];
  deadlineDay: number;
  /** Applied once after the world is built (pre-broken plans, resources, forced events). */
  setup?: (game: Game) => void;
  /** Returns progress 0..1 and whether the goal is met. */
  goal: (world: World) => { progress: number; met: boolean; label: string };
  startTimeOfDay?: number;
  config?: Partial<World['config']>;
}

const nodeDelay = (w: World, id: string): number => {
  const n = w.nodes[id];
  return n.metrics.served > 20 ? n.metrics.delayAccum / n.metrics.served : 99;
};
const worstVc = (w: World, id: string, pred: (key: string, turn: string) => boolean): number => {
  const n = w.nodes[id];
  let worst = 0;
  for (const m of Object.values(n.movements)) {
    if (!pred(m.key, m.turn)) continue;
    const d = n.metrics.demand[m.key] ?? 0;
    const c = n.metrics.capacity[m.key] ?? 0;
    if (d < 40) continue;
    worst = Math.max(worst, c > 0 ? d / c : 2);
  }
  return worst;
};
const linkDelay = (w: World, ids: string[]): number => ids.reduce((s, id) => s + (w.metrics.linkDelay[id] ?? 0), 0) / ids.length;
const peopleFlow = (w: World): number => {
  const h = w.metrics.history;
  return h.length ? h[h.length - 1].flow : 0;
};
const inLink = (w: World, node: string, leg: number): string => w.nodes[node].legs.find((l) => l.leg === leg)!.inLink!;

const BASIC = ['signal', 'protected-left', 'pocket', 'right-on-red', 'cycle'];
const NO_GROWTH = { growthPerDay: 1.0 };

export const SCENARIOS: Scenario[] = [
  {
    id: 't01-first-signal',
    title: 'First Signal',
    teaches: 'When an uncontrolled crossing needs control',
    brief: 'The centre intersection (n11) is uncontrolled and the arterial backs up every morning. Put in a signal and get average delay at n11 under 25 s.',
    map: tutorialMap,
    unlocks: BASIC,
    deadlineDay: 3,
    config: NO_GROWTH,
    goal: (w) => {
      const d = nodeDelay(w, 'n11');
      return { progress: Math.min(1, 25 / Math.max(1, d)), met: d < 25 && w.nodes['n11'].control.type === 'signal', label: `n11 delay ${d.toFixed(0)} s (target < 25)` };
    },
  },
  {
    id: 't02-lost-time',
    title: 'Lost Time',
    teaches: 'Every phase costs yellow + all-red; fewer phases, shorter cycle',
    brief: 'Somebody gave n11 a four-way split-phase plan on a 150 s cycle: 40% of every cycle is yellow and all-red. Rebuild the plan so n11 averages under 30 s of delay.',
    map: tutorialMap,
    unlocks: BASIC,
    deadlineDay: 3,
    config: NO_GROWTH,
    setup: (g) => {
      g.apply({ type: 'setControl', nodeId: 'n11', control: 'signal' });
      for (const leg of g.world.nodes['n11'].legs) if (leg.inLink) g.apply({ type: 'setLeftTreatment', nodeId: 'n11', linkId: leg.inLink, treatment: 'split' });
      g.apply({ type: 'setCycle', nodeId: 'n11', cycle: 150 });
    },
    goal: (w) => {
      const d = nodeDelay(w, 'n11');
      const phases = w.nodes['n11'].control.signal?.phases.length ?? 0;
      return { progress: Math.min(1, 30 / Math.max(1, d)), met: d < 30, label: `n11 delay ${d.toFixed(0)} s, ${phases} phases (target < 30 s)` };
    },
  },
  {
    id: 't03-short-pocket',
    title: 'The Short Pocket',
    teaches: 'Turn-pocket storage length; overflow blocks the through lane',
    brief: 'The westbound left at n11 has a 20 m pocket. It fills in one cycle and the queue spills into the through lane. Lengthen it (and protect it) until the arterial through v/c is under 0.9.',
    map: tutorialMap,
    unlocks: BASIC,
    deadlineDay: 3,
    config: NO_GROWTH,
    setup: (g) => {
      const east = inLink(g.world, 'n11', 1);
      g.apply({ type: 'setControl', nodeId: 'n11', control: 'signal' });
      g.apply({ type: 'setPocket', linkId: east, spec: { side: 'left', storage: 20, source: 'median' } });
      g.apply({ type: 'setLeftTreatment', nodeId: 'n11', linkId: east, treatment: 'protected' });
      g.world.resources.laneKm = 0.5;
    },
    goal: (w) => {
      const east = inLink(w, 'n11', 1);
      const vc = worstVc(w, 'n11', (k, t) => t === 'T' && k.startsWith(east));
      const storage = w.links[east].pocketLeft ? w.links[east].pocketLeft.end - w.links[east].pocketLeft.start : 0;
      return { progress: Math.min(1, 0.9 / Math.max(0.01, vc)), met: vc < 0.9 && storage >= 50, label: `eastbound through v/c ${vc.toFixed(2)}, pocket ${storage.toFixed(0)} m (target v/c < 0.9)` };
    },
  },
  {
    id: 't04-permitted-left',
    title: 'Permitted-Left Starvation',
    teaches: 'A permitted left facing a heavy through never finds a gap',
    brief: 'All three arterial signals run permitted lefts. The lefts at n11 are starving and queue back into the through lanes. Protect them (pockets help) until the worst left v/c at n11 is under 0.9 — without sending n11 above LOS D.',
    map: tutorialMap,
    unlocks: BASIC,
    deadlineDay: 3,
    config: NO_GROWTH,
    setup: (g) => {
      for (const id of ['n10', 'n11', 'n12']) g.apply({ type: 'setControl', nodeId: id, control: 'signal' });
      g.world.resources.laneKm = 0.6;
    },
    goal: (w) => {
      const vc = worstVc(w, 'n11', (_, t) => t === 'L');
      const los = w.nodes['n11'].metrics.los;
      return { progress: Math.min(1, 0.9 / Math.max(0.01, vc)), met: vc < 0.9 && los <= 'D', label: `worst left v/c ${vc.toFixed(2)}, LOS ${los} (target < 0.9, ≤ D)` };
    },
  },
  {
    id: 't05-minor-starvation',
    title: 'Who Gets the Green',
    teaches: 'Splits, cycle length and actuation for an unbalanced crossing',
    brief: 'n12 runs a fixed 120 s cycle that gives the side street 10 s. The side street is dying. Fix the splits — or let detectors do it — until every minor-street movement at n12 is under v/c 0.9 while the arterial stays under 0.95.',
    map: tutorialMap,
    unlocks: [...BASIC, 'actuation'],
    deadlineDay: 3,
    config: NO_GROWTH,
    setup: (g) => {
      g.apply({ type: 'setControl', nodeId: 'n12', control: 'signal' });
      g.apply({ type: 'setCycle', nodeId: 'n12', cycle: 120 });
      const plan = g.world.nodes['n12'].control.signal!;
      const north = inLink(g.world, 'n12', 0);
      const minorIdx = plan.phases.findIndex((p) => p.movements.some((m) => m.startsWith(north)));
      if (minorIdx >= 0) g.apply({ type: 'setSplit', nodeId: 'n12', phaseIndex: minorIdx, split: 10 });
    },
    goal: (w) => {
      const north = inLink(w, 'n12', 0);
      const south = inLink(w, 'n12', 2);
      const minor = worstVc(w, 'n12', (k) => k.startsWith(north) || k.startsWith(south));
      const major = worstVc(w, 'n12', (k) => !k.startsWith(north) && !k.startsWith(south));
      return { progress: Math.min(1, 0.9 / Math.max(0.01, minor)), met: minor < 0.9 && major < 0.95, label: `minor v/c ${minor.toFixed(2)}, arterial v/c ${major.toFixed(2)}` };
    },
  },
  {
    id: 't06-driveways',
    title: 'The Mall Opens',
    teaches: 'Access management: left-ins across traffic, right-in/right-out, driveway placement',
    brief: 'A mall opened on the arterial at h11 with full-access driveways. Left-ins across the eastbound lanes are stopping the arterial dead. Use the driveway tools (and the median) to get the delay on both h11 links under 15 s.',
    map: tutorialMap,
    unlocks: [...BASIC, 'driveway'],
    deadlineDay: 3,
    config: NO_GROWTH,
    setup: (g) => {
      const mall = g.world.generators['mall'];
      mall.active = true;
      mall.size = 60;
      g.apply({ type: 'setControl', nodeId: 'n11', control: 'signal' });
      g.apply({ type: 'setControl', nodeId: 'n12', control: 'signal' });
    },
    goal: (w) => {
      const d = linkDelay(w, ['h11>', 'h11<']);
      return { progress: Math.min(1, 15 / Math.max(1, d)), met: d < 15, label: `h11 link delay ${d.toFixed(0)} s (target < 15)` };
    },
  },
  {
    id: 't07-people',
    title: 'Move People, Not Cars',
    teaches: 'Bus lanes and priority can beat a car lane',
    brief: 'The bus loop shares the arterial queues. Give it a lane or priority and get the hourly people-flow above 1,800 without the gridlock meter passing 0.5.',
    map: tutorialMap,
    unlocks: [...BASIC, 'actuation', 'bus-lane', 'tsp'],
    deadlineDay: 4,
    config: NO_GROWTH,
    setup: (g) => {
      for (const id of ['n10', 'n11', 'n12']) g.apply({ type: 'setControl', nodeId: id, control: 'signal' });
      g.world.busRoutes['bus1'].headway = 180;
    },
    goal: (w) => {
      const flow = peopleFlow(w);
      return { progress: Math.min(1, flow / 1800), met: flow > 1800 && w.metrics.gridlockPeakToday < 0.5, label: `${flow.toFixed(0)} people/h (target > 1800)` };
    },
  },
  {
    id: 't08-green-wave',
    title: 'Green Wave',
    teaches: 'Coordination: common cycle and offsets along a corridor',
    brief: 'n10, n11 and n12 are signalised with the same cycle but random offsets, so every platoon stops at every light. Coordinate them and get the average delay on the arterial links between them under 10 s.',
    map: tutorialMap,
    unlocks: [...BASIC, 'actuation', 'coordination'],
    deadlineDay: 3,
    config: NO_GROWTH,
    setup: (g) => {
      for (const id of ['n10', 'n11', 'n12']) {
        g.apply({ type: 'setControl', nodeId: id, control: 'signal' });
        g.apply({ type: 'setCycle', nodeId: id, cycle: 80 });
      }
      g.apply({ type: 'defineCorridor', id: 'arterial', nodeIds: ['n10', 'n11', 'n12'] });
      // Random-looking offsets.
      g.world.nodes['n10'].control.runtime!.stateStart -= 23;
      g.world.nodes['n12'].control.runtime!.stateStart -= 47;
    },
    goal: (w) => {
      const d = linkDelay(w, ['h10>', 'h11>', 'h10<', 'h11<']);
      const coordinated = ['n10', 'n11', 'n12'].every((id) => w.nodes[id].control.signal?.coordinated);
      return { progress: Math.min(1, 10 / Math.max(1, d)), met: d < 10 && coordinated, label: `arterial link delay ${d.toFixed(0)} s (target < 10, coordinated)` };
    },
  },
  {
    id: 't09-roundabout',
    title: 'The Roundabout Question',
    teaches: 'Roundabouts suit balanced flows; a dominant approach starves the others',
    brief: 'You have one structure token. n01 (the north gateway crossing) and n21 (the south gateway crossing) are both busy. One has balanced flows, one does not. Put the roundabout where it belongs and get both to LOS C or better.',
    map: tutorialMap,
    unlocks: [...BASIC, 'roundabout'],
    deadlineDay: 3,
    config: NO_GROWTH,
    setup: (g) => {
      g.world.resources.tokens = 1;
      g.world.generators['gN1'].size = 45;
    },
    goal: (w) => {
      const a = w.nodes['n01'].metrics.los;
      const b = w.nodes['n21'].metrics.los;
      const ok = a <= 'C' && b <= 'C';
      return { progress: ok ? 1 : a <= 'C' || b <= 'C' ? 0.5 : 0.1, met: ok, label: `n01 LOS ${a}, n21 LOS ${b} (target ≤ C)` };
    },
  },
  {
    id: 't10-metering',
    title: 'Match Day',
    teaches: 'Metering: hold traffic where there is storage, not where it cross-blocks',
    brief: 'The stadium lets out at 20:30 today: 10,000 people in 40 minutes onto h21. Last time the whole south side gridlocked. Use metering on the signals upstream of n21 (and anything else you like) to keep the gridlock meter under 0.4 through the let-out.',
    map: tutorialMap,
    unlocks: ['*'],
    deadlineDay: 1,
    startTimeOfDay: 0.7,
    config: NO_GROWTH,
    setup: (g) => {
      const w = g.world;
      w.generators['stadium'].active = true;
      scheduleEvent(w, 'stadium-letout', 0.85, 0.92, 'stadium');
      for (const id of ['n20', 'n21', 'n22', 'n10', 'n11', 'n12']) g.apply({ type: 'setControl', nodeId: id, control: 'signal' });
    },
    goal: (w) => {
      const gl = w.metrics.gridlockPeakToday;
      const done = w.day >= 1 || w.t % w.config.dayLength > 0.95 * w.config.dayLength;
      return { progress: Math.min(1, 0.4 / Math.max(0.01, gl)), met: done && gl < 0.4, label: `gridlock peak ${gl.toFixed(2)} (target < 0.4 through 22:00)` };
    },
  },
  {
    id: 'endless-tutorial',
    title: 'Endless: Tutorial City',
    teaches: 'Everything',
    brief: 'Survive as long as you can. Demand grows 6% a day.',
    map: tutorialMap,
    unlocks: ['*'],
    deadlineDay: Infinity,
    goal: (w) => ({ progress: Math.min(1, w.day / 30), met: false, label: `Day ${w.day} · avg delay ${averageDelay(w).toFixed(0)} s` }),
  },
  {
    id: 'endless-radial',
    title: 'Endless: Radial City',
    teaches: 'Tidal flows into a centre',
    brief: 'Jobs inside, homes outside. Every morning floods in, every evening floods out.',
    map: radialMap,
    unlocks: ['*'],
    deadlineDay: Infinity,
    goal: (w) => ({ progress: Math.min(1, w.day / 30), met: false, label: `Day ${w.day} · avg delay ${averageDelay(w).toFixed(0)} s` }),
  },
  {
    id: 'endless-river',
    title: 'Endless: River City',
    teaches: 'Three bridges, one direction at a time',
    brief: 'Homes west, jobs east, three bridges. Tidal flow and metering earn their keep here.',
    map: riverMap,
    unlocks: ['*'],
    deadlineDay: Infinity,
    goal: (w) => ({ progress: Math.min(1, w.day / 30), met: false, label: `Day ${w.day} · avg delay ${averageDelay(w).toFixed(0)} s` }),
  },
];

export const TUTORIAL_CHAIN = SCENARIOS.filter((s) => s.id.startsWith('t')).map((s) => s.id);

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Next tutorial after `id`, or null at the end of the chain. */
export function nextInChain(id: string): Scenario | null {
  const i = TUTORIAL_CHAIN.indexOf(id);
  return i >= 0 && i + 1 < TUTORIAL_CHAIN.length ? scenarioById(TUTORIAL_CHAIN[i + 1]) ?? null : null;
}
