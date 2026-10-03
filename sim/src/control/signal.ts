/**
 * Ring-barrier-lite signal controller: a single ring of phases with fixed-time,
 * actuated, coordinated, metered, TSP and pre-emption behaviour. Lost time is
 * explicit: every phase change costs yellow + all-red computed from approach speed.
 */
import {
  PED_WALK_INTERVAL,
  PED_WALK_SPEED,
  type Detector,
  type LinkId,
  type Movement,
  type Phase,
  type SignalPlan,
  type SignalRuntime,
  type SimNode,
  type World,
} from '../model/types.js';
import { isHardConflict } from '../network/geometry.js';
import { allTrafficLanes, lanesAllowing } from '../network/lanes.js';
import { linkOccupancy, posOf, vehicleLength } from '../traffic/access.js';

export const MIN_GREEN_DEFAULT = 7;

/** Yellow (ITE kinematic) and all-red clearance for a node approached at speed v (m/s). */
export function intergreen(node: SimNode, world: World): { yellow: number; allRed: number } {
  let v = 10;
  for (const leg of node.legs) if (leg.inLink) v = Math.max(v, world.links[leg.inLink].speedLimit);
  const yellow = Math.round((1.0 + v / (2 * 3.0)) * 10) / 10;
  const allRed = Math.round(((2 * node.radius + 5) / v) * 10) / 10;
  return { yellow, allRed };
}

export function lostTimePerPhase(node: SimNode, world: World): number {
  const ig = intergreen(node, world);
  // Start-up lost time (~2 s) + unused clearance (~ all-red + part of yellow).
  return 2 + ig.allRed + ig.yellow * 0.5;
}

/** Ped walk + clearance for a crossing of given width. */
export function pedMinTime(width: number): number {
  return PED_WALK_INTERVAL + width / PED_WALK_SPEED;
}

export function emptyRuntime(t: number): SignalRuntime {
  return {
    phaseIdx: 0,
    state: 'green',
    stateStart: t,
    greenStart: t,
    lastCall: t,
    calls: [],
    tspUsedThisCycle: false,
    cycleStart: t,
    preempt: null,
    preemptUntil: 0,
    malfunction: false,
    greenLog: [],
  };
}

export function emptyPlan(): SignalPlan {
  return {
    phases: [],
    cycle: 0,
    rightOnRed: {},
    leftTreatment: {},
    pedTreatment: 'concurrent',
    actuated: false,
    detectors: [],
    coordinated: false,
    offset: 0,
    tsp: false,
    tspMaxExtend: 10,
    laggingLeft: false,
  };
}

/** Which ped crossings a vehicle phase may serve concurrently: those with no hard conflict. */
function concurrentPeds(node: SimNode, movements: string[]): string[] {
  const out: string[] = [];
  for (const p of Object.values(node.peds)) {
    if (!p.enabled) continue;
    const ok = movements.every((m) => !isHardConflict(node.conflicts[m]?.[p.key] ?? 'none'));
    if (ok) out.push(p.key);
  }
  return out;
}

/**
 * Normalise a plan: compute per-phase served peds, ped-driven minimum greens,
 * add/remove the exclusive ped phase, and recompute cycle = Σ(split + intergreen).
 */
export function normalisePlan(node: SimNode, world: World, plan: SignalPlan): void {
  const ig = intergreen(node, world);
  const inter = ig.yellow + ig.allRed;
  // Drop movements that no longer exist or are served by a slip lane (they never need green).
  for (const ph of plan.phases) ph.movements = ph.movements.filter((m) => node.movements[m] && !node.movements[m].slip);
  plan.phases = plan.phases.filter((ph) => ph.movements.length || ph.id === -1);
  const exclusive = plan.pedTreatment === 'exclusive' || plan.pedTreatment === 'scramble';
  let pedPhase = plan.phases.find((p) => p.id === -1);
  if (exclusive) {
    const allPeds = Object.values(node.peds).filter((p) => p.enabled);
    const maxTime = Math.max(0, ...allPeds.map((p) => pedMinTime(p.width)));
    if (!pedPhase) {
      pedPhase = { id: -1, movements: [], peds: [], split: maxTime, minGreen: maxTime, maxGreen: maxTime, coordinated: false, meterLink: null, meterThreshold: 0.8, lpi: 0 };
      plan.phases.push(pedPhase);
    }
    pedPhase.peds = allPeds.map((p) => p.key);
    pedPhase.split = pedPhase.minGreen = pedPhase.maxGreen = Math.max(5, maxTime * (plan.pedTreatment === 'scramble' ? 0.9 : 1));
    for (const ph of plan.phases) if (ph.id !== -1) ph.peds = [];
  } else {
    plan.phases = plan.phases.filter((p) => p.id !== -1);
    for (const ph of plan.phases) {
      ph.peds = concurrentPeds(node, ph.movements);
      ph.lpi = plan.pedTreatment === 'lpi' ? 5 : 0;
    }
  }
  for (const ph of plan.phases) {
    if (ph.id === -1) continue;
    const pedMin = Math.max(0, ...ph.peds.map((k) => pedMinTime(node.peds[k].width)));
    // Fixed-time: ped min always applies; actuated: only when peds call (handled at runtime).
    ph.minGreen = Math.max(MIN_GREEN_DEFAULT, plan.actuated ? MIN_GREEN_DEFAULT : pedMin) + ph.lpi;
    if (ph.split < ph.minGreen) ph.split = ph.minGreen;
    if (ph.maxGreen < ph.split) ph.maxGreen = ph.split;
  }
  plan.cycle = plan.phases.reduce((s, p) => s + p.split + inter, 0);
}

/** Scale all splits so the cycle equals `cycle` (respecting minimums). */
export function setCycle(node: SimNode, world: World, plan: SignalPlan, cycle: number): void {
  const ig = intergreen(node, world);
  const inter = ig.yellow + ig.allRed;
  const n = plan.phases.length;
  if (!n) return;
  const available = cycle - inter * n;
  const totalSplit = plan.phases.reduce((s, p) => s + p.split, 0) || 1;
  for (const p of plan.phases) p.split = Math.max(p.minGreen, (p.split / totalSplit) * available);
  for (const p of plan.phases) p.maxGreen = Math.max(p.maxGreen, p.split);
  normalisePlan(node, world, plan);
}

/** Efficiency = green time / cycle. */
export function planEfficiency(node: SimNode, world: World, plan: SignalPlan): { lost: number; efficiency: number } {
  const lost = plan.phases.length * lostTimePerPhase(node, world);
  return { lost, efficiency: plan.cycle > 0 ? Math.max(0, 1 - lost / plan.cycle) : 0 };
}

// ───────────────────────────── auto plan builder ─────────────────────────────

function mainLegs(node: SimNode, world: World): [LinkId[], LinkId[]] {
  // Pair opposite legs: (0,2) and (1,3). Return inbound links for each pair.
  const pair = (a: number, b: number): LinkId[] =>
    node.legs.filter((l) => (l.leg === a || l.leg === b) && l.inLink).map((l) => l.inLink as LinkId);
  const p02 = pair(0, 2);
  const p13 = pair(1, 3);
  const lanes = (ls: LinkId[]): number => ls.reduce((s, l) => s + lanesAllowing(world.links[l], 'T').length, 0);
  return lanes(p02) >= lanes(p13) ? [p02, p13] : [p13, p02];
}

/**
 * Build a sensible default plan: two through phases, with lefts protected (own phase),
 * permitted (in the through phase) or protected+permitted (lead + permitted), or split
 * (each approach gets its own phase) per the approach's left treatment.
 */
export function autoPlan(node: SimNode, world: World, existing?: SignalPlan): SignalPlan {
  const plan: SignalPlan = existing ? { ...existing, phases: [] } : emptyPlan();
  const [major, minor] = mainLegs(node, world);
  let id = 1;
  const mk = (movements: string[], split: number, coordinated = false): Phase => ({
    id: id++,
    movements: movements.filter((m) => node.movements[m]),
    peds: [],
    split,
    minGreen: MIN_GREEN_DEFAULT,
    maxGreen: split * 1.5,
    coordinated,
    meterLink: null,
    meterThreshold: 0.8,
    lpi: 0,
  });
  const build = (links: LinkId[], split: number, coordinated: boolean): void => {
    const treatments = links.map((l) => plan.leftTreatment[l] ?? 'permitted');
    const throughs = links.flatMap((l) => [`${l}:T`, `${l}:R`]);
    if (treatments.some((t) => t === 'split')) {
      for (const l of links) plan.phases.push(mk([`${l}:T`, `${l}:R`, `${l}:L`, `${l}:U`], split / 2, coordinated));
      return;
    }
    const protectedLefts = links.filter((l, i) => treatments[i] === 'protected' || treatments[i] === 'protected-permitted').flatMap((l) => [`${l}:L`, `${l}:U`]);
    const permittedLefts = links.filter((l, i) => treatments[i] === 'permitted' || treatments[i] === 'protected-permitted').flatMap((l) => [`${l}:L`, `${l}:U`]);
    if (protectedLefts.length && !plan.laggingLeft) plan.phases.push(mk(protectedLefts, Math.max(8, split * 0.3)));
    plan.phases.push(mk([...throughs, ...permittedLefts], split, coordinated));
    if (protectedLefts.length && plan.laggingLeft) plan.phases.push(mk(protectedLefts, Math.max(8, split * 0.3)));
  };
  build(major, 30, plan.coordinated);
  if (minor.length) build(minor, 20, false);
  if (!plan.phases.length) {
    // Degenerate (e.g. 2-leg node): one phase with everything.
    plan.phases.push(mk(Object.keys(node.movements), 30));
  }
  for (const leg of node.legs) if (leg.inLink && plan.rightOnRed[leg.inLink] === undefined) plan.rightOnRed[leg.inLink] = true;
  normalisePlan(node, world, plan);
  return plan;
}

// ───────────────────────────── runtime ─────────────────────────────

export function phaseServing(plan: SignalPlan, movementKey: string): number[] {
  const out: number[] = [];
  plan.phases.forEach((p, i) => {
    if (p.movements.includes(movementKey)) out.push(i);
  });
  return out;
}

export interface SignalView {
  /** Movement has a green indication now (protected or permitted). */
  green: (m: string) => boolean;
  yellow: (m: string) => boolean;
  /** Movement served in current phase but still within the leading pedestrian interval. */
  heldForLpi: (m: string) => boolean;
  /** Ped crossing has WALK now. */
  walk: (pedKey: string) => boolean;
  remainingGreen: number;
  state: SignalRuntime['state'];
}

export function signalView(node: SimNode, world: World): SignalView | null {
  const plan = node.control.signal;
  const rt = node.control.runtime;
  if (!plan || !rt || !plan.phases.length) return null;
  if (rt.malfunction) return null;
  const phase = plan.phases[rt.phaseIdx];
  const inGreen = rt.state === 'green';
  const sinceGreen = world.t - rt.greenStart;
  const served = new Set(rt.preempt ? [rt.preempt] : phase.movements);
  const peds = new Set(rt.preempt ? [] : phase.peds);
  return {
    green: (m) => inGreen && served.has(m),
    yellow: (m) => rt.state === 'yellow' && served.has(m),
    heldForLpi: (m) => inGreen && served.has(m) && sinceGreen < phase.lpi && phase.peds.some((p) => node.conflicts[m]?.[p] === 'ped-soft'),
    walk: (p) => inGreen && peds.has(p) && sinceGreen < Math.max(PED_WALK_INTERVAL, phase.split - pedMinTime(node.peds[p]?.width ?? 10) + PED_WALK_INTERVAL),
    remainingGreen: inGreen ? Math.max(0, phase.split - sinceGreen) : 0,
    state: rt.state,
  };
}

/** Is any vehicle present in the detector zone for movements of `phase`? */
function phaseHasCall(node: SimNode, world: World, plan: SignalPlan, phase: Phase): { call: boolean; inDilemma: boolean } {
  let call = false;
  let inDilemma = false;
  const dets = plan.detectors;
  for (const mk of phase.movements) {
    const m = node.movements[mk];
    if (!m) continue;
    const link = world.links[m.fromLink];
    const lanes = lanesAllowing(link, m.turn);
    for (const lane of lanes) {
      const laneDets = dets.filter((d) => d.laneId === lane.id);
      const zones = laneDets.length ? laneDets.map((d) => d.setback) : [0];
      for (const id of lane.vehicles) {
        const v = world.vehicles[id];
        const back = link.length - posOf(world, id);
        for (const sb of zones) {
          if (sb <= 5) {
            if (back < 12) call = true;
          } else {
            if (back < sb + 8) call = true;
            // dilemma zone 2.5–5.5 s from the line at current speed
            const tta = back / Math.max(v.speed, 0.1);
            if (v.speed > 8 && tta > 2.5 && tta < 5.5) inDilemma = true;
          }
        }
        if (back > 150) break;
      }
    }
  }
  for (const pk of phase.peds) if ((node.peds[pk]?.waiting ?? 0) > 0) call = true;
  return { call, inDilemma };
}

function pedCallMin(node: SimNode, phase: Phase): number {
  let m = 0;
  for (const pk of phase.peds) if ((node.peds[pk]?.waiting ?? 0) > 0) m = Math.max(m, pedMinTime(node.peds[pk].width));
  return m;
}

/** Find a bus approaching a movement in the plan within `range` metres. Returns movement key. */
function approachingBus(node: SimNode, world: World, range: number): string | null {
  for (const m of Object.values(node.movements)) {
    const link = world.links[m.fromLink];
    for (const lane of allTrafficLanes(link)) {
      for (const id of lane.vehicles) {
        const v = world.vehicles[id];
        if (v.cls !== 'bus') continue;
        const back = link.length - posOf(world, id);
        if (back < range) {
          const nm = v.route[v.routeIdx + 1] ?? (v.cyclic ? v.route[0] : null);
          if (nm === m.toLink) return m.key;
        }
      }
    }
  }
  return null;
}

function approachingEmergency(node: SimNode, world: World): string | null {
  for (const m of Object.values(node.movements)) {
    const link = world.links[m.fromLink];
    for (const lane of allTrafficLanes(link)) {
      for (const id of lane.vehicles) {
        const v = world.vehicles[id];
        if (v.cls !== 'emergency') continue;
        if (link.length - posOf(world, id) < 150 && v.route[v.routeIdx + 1] === m.toLink) return m.key;
      }
    }
  }
  return null;
}

function enterState(rt: SignalRuntime, state: SignalRuntime['state'], t: number): void {
  rt.state = state;
  rt.stateStart = t;
  if (state === 'green') rt.greenStart = t;
}

function logGreenEnd(rt: SignalRuntime, t: number): void {
  const last = rt.greenLog[rt.greenLog.length - 1];
  if (last && last.end === 0) last.end = t;
  if (rt.greenLog.length > 400) rt.greenLog.splice(0, rt.greenLog.length - 400);
}

function startGreen(rt: SignalRuntime, phaseIdx: number, t: number): void {
  rt.phaseIdx = phaseIdx;
  enterState(rt, 'green', t);
  rt.greenLog.push({ phase: phaseIdx, start: t, end: 0 });
}

/** Next phase index with a call (actuated) or simply the next (fixed). Coordinated phase is never skipped. */
function nextPhaseIdx(node: SimNode, world: World, plan: SignalPlan, from: number): number {
  const n = plan.phases.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    const ph = plan.phases[i];
    if (!plan.actuated || ph.coordinated || ph.id === -1 && Object.values(node.peds).some((p) => p.waiting > 0)) {
      if (ph.id === -1 && plan.actuated && !Object.values(node.peds).some((p) => p.waiting > 0)) continue;
      return i;
    }
    if (phaseHasCall(node, world, plan, ph).call) return i;
  }
  return (from + 1) % n;
}

/** Scheduled start (seconds into the cycle) of each phase for coordination. */
function schedule(plan: SignalPlan, node: SimNode, world: World): number[] {
  const ig = intergreen(node, world);
  const inter = ig.yellow + ig.allRed;
  const starts: number[] = [];
  let acc = 0;
  for (const p of plan.phases) {
    starts.push(acc);
    acc += p.split + inter;
  }
  // Rotate so the coordinated phase starts at 0.
  const ci = plan.phases.findIndex((p) => p.coordinated);
  if (ci > 0) {
    const shift = starts[ci];
    for (let i = 0; i < starts.length; i++) starts[i] = ((starts[i] - shift) % plan.cycle + plan.cycle) % plan.cycle;
  }
  return starts;
}

export function updateSignal(node: SimNode, world: World, dt: number): void {
  const plan = node.control.signal;
  if (!plan || !plan.phases.length) return;
  if (!node.control.runtime) node.control.runtime = emptyRuntime(world.t);
  const rt = node.control.runtime;
  if (rt.malfunction) return;
  const t = world.t;
  const ig = intergreen(node, world);
  const phase = plan.phases[rt.phaseIdx] ?? plan.phases[0];
  const elapsed = t - rt.stateStart;

  // ── Pre-emption ──
  if (!rt.preempt) {
    const em = approachingEmergency(node, world);
    if (em && !phase.movements.includes(em)) {
      rt.preempt = em;
      rt.preemptUntil = t + 30;
      if (rt.state === 'green') {
        logGreenEnd(rt, t);
        enterState(rt, 'yellow', t);
      }
    } else if (em) {
      rt.preempt = em;
      rt.preemptUntil = t + 30;
    }
  } else {
    const stillThere = approachingEmergency(node, world) === rt.preempt || node.occupants.some((id) => world.vehicles[id].cls === 'emergency');
    if (!stillThere || t > rt.preemptUntil) {
      rt.preempt = null;
      // Resume: go through clearance into the next phase with a call.
      if (rt.state === 'green') {
        logGreenEnd(rt, t);
        enterState(rt, 'yellow', t);
      }
    }
  }

  switch (rt.state) {
    case 'green': {
      if (rt.preempt && phase.movements.includes(rt.preempt)) return; // hold for the emergency vehicle
      if (rt.preempt) return; // handled above (went yellow)
      let target = phase.split;
      let minG = phase.minGreen;
      if (plan.actuated) {
        const pedMin = pedCallMin(node, phase);
        minG = Math.max(phase.minGreen, pedMin + phase.lpi);
        target = Math.max(minG, phase.maxGreen);
      }
      // Metering: when the protected downstream link is congested, cut this phase to its minimum.
      if (phase.meterLink && linkOccupancy(world, phase.meterLink) > phase.meterThreshold) target = minG;

      // Coordination: coordinated phase ends at its scheduled end; others end at schedule or earlier (gap out).
      if (plan.coordinated && plan.cycle > 0) {
        const starts = schedule(plan, node, world);
        const local = (((t - plan.offset) % plan.cycle) + plan.cycle) % plan.cycle;
        const i = rt.phaseIdx;
        const myStart = starts[i];
        const nextStart = starts[(i + 1) % plan.phases.length];
        const inter = ig.yellow + ig.allRed;
        let remaining = ((nextStart - inter - local) % plan.cycle + plan.cycle) % plan.cycle;
        if (phase.coordinated) {
          // Hold until the scheduled end; never gap out.
          if (remaining > 0.05 && remaining < plan.cycle - 1) return;
          logGreenEnd(rt, t);
          enterState(rt, 'yellow', t);
          return;
        }
        // Non-coordinated: cannot run past schedule.
        const sinceStart = ((local - myStart) % plan.cycle + plan.cycle) % plan.cycle;
        target = Math.min(target, sinceStart + remaining);
      }

      let end = elapsed >= target;
      if (plan.actuated && !end && elapsed >= minG) {
        const { call, inDilemma } = phaseHasCall(node, world, plan, phase);
        if (call) rt.lastCall = t;
        const passage = 3.0;
        if (!inDilemma && t - rt.lastCall > passage) {
          // Gap out — but only if another phase has a call.
          const nxt = nextPhaseIdx(node, world, plan, rt.phaseIdx);
          if (nxt !== rt.phaseIdx && phaseHasCall(node, world, plan, plan.phases[nxt]).call) end = true;
          else if (nxt !== rt.phaseIdx && plan.phases[nxt].coordinated) end = true;
        } else if (inDilemma && elapsed < phase.maxGreen) {
          end = false;
        }
      }
      // Transit signal priority: extend if a bus is close and we are about to end.
      if (plan.tsp && !rt.tspUsedThisCycle && end) {
        const bus = approachingBus(node, world, 80);
        if (bus && phase.movements.includes(bus) && elapsed < target + plan.tspMaxExtend) {
          end = false;
          if (elapsed >= target + plan.tspMaxExtend - dt) rt.tspUsedThisCycle = true;
        }
      }
      // TSP truncation: a bus is waiting on another phase; cut this one at min green.
      if (plan.tsp && !rt.tspUsedThisCycle && !end && elapsed >= minG && !phase.coordinated) {
        const bus = approachingBus(node, world, 60);
        if (bus && !phase.movements.includes(bus)) {
          end = true;
          rt.tspUsedThisCycle = true;
        }
      }
      if (end) {
        logGreenEnd(rt, t);
        enterState(rt, 'yellow', t);
      }
      return;
    }
    case 'yellow':
      if (elapsed >= ig.yellow) enterState(rt, 'all-red', t);
      return;
    case 'all-red': {
      if (elapsed < ig.allRed) return;
      // Choose next phase.
      let nxt: number;
      if (rt.preempt) {
        const serving = plan.phases.findIndex((p) => p.movements.includes(rt.preempt as string));
        nxt = serving >= 0 ? serving : rt.phaseIdx;
      } else if (plan.coordinated && plan.cycle > 0 && plan.actuated) {
        // After an early gap-out, jump to the coordinated phase if its scheduled time is near or passed.
        const starts = schedule(plan, node, world);
        const local = (((t - plan.offset) % plan.cycle) + plan.cycle) % plan.cycle;
        const ci = plan.phases.findIndex((p) => p.coordinated);
        nxt = nextPhaseIdx(node, world, plan, rt.phaseIdx);
        if (ci >= 0) {
          const untilCoord = ((starts[ci] - local) % plan.cycle + plan.cycle) % plan.cycle;
          const ph = plan.phases[nxt];
          if (nxt !== ci && untilCoord < ph.minGreen + ig.yellow + ig.allRed) nxt = ci;
        }
      } else {
        nxt = nextPhaseIdx(node, world, plan, rt.phaseIdx);
      }
      if (nxt <= rt.phaseIdx) {
        rt.cycleStart = t;
        rt.tspUsedThisCycle = false;
      }
      startGreen(rt, nxt, t);
      // Peds served by this phase start walking.
      for (const pk of plan.phases[nxt].peds) {
        const p = node.peds[pk];
        if (p && p.waiting > 0) {
          p.served += p.waiting;
          p.waiting = 0;
          p.crossingUntil = t + p.width / PED_WALK_SPEED + (plan.phases[nxt].lpi || 0);
        }
      }
      return;
    }
  }
}

/** Build a movement→capacity estimate (veh/h) for a signalised node from its plan. */
export function signalCapacities(node: SimNode, world: World, satFlow: (laneId: string) => number): Record<string, number> {
  const plan = node.control.signal;
  const out: Record<string, number> = {};
  if (!plan || !plan.cycle) return out;
  const lost = lostTimePerPhase(node, world);
  for (const m of Object.values(node.movements)) {
    const link = world.links[m.fromLink];
    const lanes = lanesAllowing(link, m.turn);
    if (m.slip) {
      out[m.key] = slipCapacity(node, m, lanes.length || 1);
      continue;
    }
    let g = 0;
    for (const i of phaseServing(plan, m.key)) g += Math.max(0, plan.phases[i].split - lost + 2);
    const permittedFactor = m.turn === 'L' && (plan.leftTreatment[m.fromLink] ?? 'permitted') === 'permitted' ? 0.45 : m.turn === 'R' ? 0.85 : 1;
    let cap = 0;
    for (const lane of lanes) cap += (satFlow(lane.id) / Math.max(1, lane.allowed.length)) * (g / plan.cycle) * permittedFactor;
    if (m.turn === 'R' && plan.rightOnRed[m.fromLink]) cap += 150;
    out[m.key] = cap;
  }
  return out;
}

/** Capacity of a channelised right: free-flow ~1500/lane; yield depends on the cross-street flow it merges with. */
export function slipCapacity(node: SimNode, m: Movement, lanes: number): number {
  const leg = node.legs.find((l) => l.leg === m.entryLeg);
  if (leg?.slipMode === 'free') return 1500 * lanes;
  let vc = 0;
  for (const o of Object.values(node.movements)) if (o.toLink === m.toLink && o.key !== m.key) vc += node.metrics.demand[o.key] ?? 0;
  const a = Math.exp((-vc * 4.0) / 3600);
  const b = 1 - Math.exp((-vc * 2.5) / 3600);
  return lanes * (vc > 0 ? (vc * a) / Math.max(1e-6, b) : 1400);
}

export function detectorsFor(plan: SignalPlan, laneId: string): Detector[] {
  return plan.detectors.filter((d) => d.laneId === laneId);
}

export function movementsOfLink(node: SimNode, linkId: LinkId): Movement[] {
  return Object.values(node.movements).filter((m) => m.fromLink === linkId);
}

export { vehicleLength };
