/**
 * Intersection manager: decides whether the front vehicle of a lane may enter the node
 * under the node's control, and handles gap acceptance against conflicting traffic.
 */
import type { ConflictKind, Leg, Movement, SimNode, Turn, Vehicle, World } from '../model/types.js';
import { conflictBetween, isHardConflict, yieldsTo } from '../network/geometry.js';
import { lanesAllowing } from '../network/lanes.js';
import { nextMovement, posOf, vehicleLength } from '../traffic/access.js';
import { signalView, type SignalView } from './signal.js';

/** Critical gaps (s) by situation — HCM-flavoured. */
export const CRITICAL_GAP = {
  permittedLeft: 4.5,
  rightOnRed: 5.5,
  minorThrough: 6.5,
  minorLeft: 7.1,
  minorRight: 6.2,
  yieldThrough: 5.0,
  uncontrolled: 4.0,
  roundabout: 4.3,
  pedYield: 2.0,
};

export interface Approaching {
  v: Vehicle;
  movement: Movement;
  /** Seconds until the vehicle reaches the stop line at current speed (≥ 0). */
  tta: number;
  atLine: boolean;
}

/** Collect vehicles within `horizon` seconds of the stop line on every approach of the node. */
export function approachingVehicles(world: World, node: SimNode, horizon = 8): Approaching[] {
  const out: Approaching[] = [];
  for (const leg of node.legs) {
    if (!leg.inLink) continue;
    const link = world.links[leg.inLink];
    const lanes = [link.pocketLeft, ...link.lanes, link.pocketRight].filter(Boolean);
    for (const lane of lanes) {
      if (!lane || lane.type === 'parking') continue;
      for (const id of lane.vehicles) {
        const v = world.vehicles[id];
        const back = link.length - posOf(world, id);
        if (back > 150) break;
        const tta = back / Math.max(v.speed, 0.5);
        if (tta > horizon && back > 15) break;
        const m = nextMovement(world, v);
        if (!m) continue;
        out.push({ v, movement: m, tta: Math.max(0, tta), atLine: back < 4 });
      }
    }
  }
  return out;
}

/** Roundabout conflict: does entering from `entry` cross the circulating path of movement m? */
export function roundaboutConflict(entry: Leg, m: Movement): ConflictKind {
  if (m.entryLeg === entry) return 'none';
  // Circulating counter-clockwise: from leg j the path passes j-1, j-2, j-3.
  const steps: Record<Turn, number> = { R: 0, T: 1, L: 2, U: 3 };
  const n = steps[m.turn];
  for (let k = 1; k <= n; k++) if (((m.entryLeg - k + 4) % 4) === entry) return 'cross';
  return 'none';
}

function conflictKind(node: SimNode, a: Movement, b: Movement): ConflictKind {
  if (node.control.type === 'roundabout') return roundaboutConflict(a.entryLeg, b);
  return conflictBetween(node, a.key, b.key);
}

/** Occupants of the node whose movement conflicts (hard or merge) with `m`. */
function conflictingOccupant(world: World, node: SimNode, m: Movement, v: Vehicle): { hard: boolean; mergeAhead: Vehicle | null } {
  let hard = false;
  let mergeAhead: Vehicle | null = null;
  for (const id of node.occupants) {
    if (id === v.id) continue;
    const o = world.vehicles[id];
    if (o.place.kind !== 'node') continue;
    const om = node.movements[o.place.movement];
    if (!om) continue;
    const k = conflictKind(node, m, om);
    if (k === 'cross') {
      // Occupant still ahead of the crossing point? Approximate: conflicts until it has exited.
      hard = true;
    } else if (k === 'merge') {
      mergeAhead = o;
    }
  }
  return { hard, mergeAhead };
}

/** Gap acceptance against approaching vehicles on movements that have priority over `m`. */
function gapAccepted(world: World, node: SimNode, m: Movement, v: Vehicle, approaching: Approaching[], criticalGap: number, prioritySet: (other: Approaching) => boolean): boolean {
  for (const a of approaching) {
    if (a.v.id === v.id) continue;
    if (a.movement.fromLink === m.fromLink) continue;
    const k = conflictKind(node, m, a.movement);
    if (k === 'none') continue;
    if (!prioritySet(a)) continue;
    // A vehicle that is itself stopped and waiting is not a threat unless it is at the line with right of way.
    if (a.v.speed < 0.5 && !a.atLine) continue;
    if (a.tta < criticalGap) return false;
  }
  return true;
}

function pedInCrosswalk(node: SimNode, m: Movement, world: World): boolean {
  for (const p of Object.values(node.peds)) {
    if (!p.enabled) continue;
    if (p.crossingUntil > world.t && conflictBetween(node, m.key, p.key) !== 'none') return true;
  }
  return false;
}

export type EntryDecision = { go: true; mergeLeader: Vehicle | null } | { go: false; reason: string; mustStop: boolean };

const NO: (reason: string, mustStop?: boolean) => EntryDecision = (reason, mustStop = false) => ({ go: false, reason, mustStop });

/** Approach must come to a complete stop first (stop control, right-on-red, AWSC). */
function stoppedOk(v: Vehicle): boolean {
  return v.hasStopped;
}

/**
 * Decide whether vehicle `v`, at the stop line of its lane on `m.fromLink`, may enter the node.
 * `approaching` is the pre-collected list for this node this tick.
 */
export function mayEnter(world: World, node: SimNode, v: Vehicle, m: Movement, approaching: Approaching[], sig: SignalView | null): EntryDecision {
  if (node.banned.includes(m.key)) return NO('banned');
  // Free-flow (grade-separated) movements ignore control and conflicts.
  if (node.conflictOverrides && node.form === 'interchange-terminal' && isFreeFlowMovement(node, m)) return { go: true, mergeLeader: null };

  // Box protection: enough room on the destination lane?
  if (node.boxProtection && !destinationHasRoom(world, node, v, m)) return NO('box');

  const occ = conflictingOccupant(world, node, m, v);
  if (occ.hard) return NO('occupied');

  const control = node.control;
  const flashing = control.runtime?.malfunction ?? false;
  const type = flashing && control.type === 'signal' ? 'all-way-stop' : control.type;

  switch (type) {
    case 'signal': {
      if (!sig) return allWayStop(world, node, v, m, approaching, occ.mergeAhead);
      if (sig.green(m.key)) {
        if (sig.heldForLpi(m.key)) return NO('lpi');
        // Permitted movements yield to conflicting green movements (e.g. permitted left vs opposite through).
        const protectedPhase = isProtected(node, m, sig);
        if (!protectedPhase) {
          // A permitted movement yields to every conflicting movement that also has green.
          const ok = gapAccepted(world, node, m, v, approaching, CRITICAL_GAP.permittedLeft, (a) => sig.green(a.movement.key) && isHardConflict(conflictBetween(node, a.movement.key, m.key)));
          if (!ok) return NO('gap');
        }
        if (pedInCrosswalk(node, m, world) && conflictBetween(node, m.key, pedKeyFor(node, m.exitLeg)) === 'ped-soft') return NO('peds');
        return { go: true, mergeLeader: occ.mergeAhead };
      }
      if (sig.yellow(m.key)) {
        // Enter on yellow only if we cannot comfortably stop.
        const link = world.links[m.fromLink];
        const back = link.length - posOf(world, v.id);
        const stopDist = (v.speed * v.speed) / (2 * 3.0);
        if (stopDist > back && v.speed > 2) return { go: true, mergeLeader: occ.mergeAhead };
        return NO('yellow');
      }
      // Red. Right on red / channelised right.
      const leg = node.legs.find((l) => l.leg === m.entryLeg);
      if (m.turn === 'R' && (leg?.channelisedRight || node.control.signal?.rightOnRed[m.fromLink])) {
        if (!leg?.channelisedRight && !stoppedOk(v)) return NO('stop-first', true);
        if (pedInCrosswalk(node, m, world)) return NO('peds');
        const ok = gapAccepted(world, node, m, v, approaching, CRITICAL_GAP.rightOnRed, (a) => sig.green(a.movement.key) || a.movement.turn === 'R' && a.atLine && a.v.id < v.id);
        if (!ok) return NO('gap');
        return { go: true, mergeLeader: occ.mergeAhead };
      }
      return NO('red');
    }
    case 'uncontrolled': {
      const ok = gapAccepted(world, node, m, v, approaching, CRITICAL_GAP.uncontrolled, (a) => yieldsTo(m, a.movement, conflictKind(node, m, a.movement)));
      if (!ok) return NO('gap');
      if (pedInCrosswalk(node, m, world)) return NO('peds');
      return { go: true, mergeLeader: occ.mergeAhead };
    }
    case 'two-way-stop':
    case 'yield': {
      const minor = control.minorLinks.includes(m.fromLink);
      if (minor) {
        if (type === 'two-way-stop' && !stoppedOk(v)) return NO('stop-first', true);
        const gap = m.turn === 'L' || m.turn === 'U' ? CRITICAL_GAP.minorLeft : m.turn === 'R' ? CRITICAL_GAP.minorRight : type === 'yield' ? CRITICAL_GAP.yieldThrough : CRITICAL_GAP.minorThrough;
        const ok = gapAccepted(world, node, m, v, approaching, gap, (a) => !control.minorLinks.includes(a.movement.fromLink) || yieldsTo(m, a.movement, conflictKind(node, m, a.movement)));
        if (!ok) return NO('gap');
        if (pedInCrosswalk(node, m, world)) return NO('peds');
        return { go: true, mergeLeader: occ.mergeAhead };
      }
      // Major: only yield to other majors per normal rules (left yields to opposite through).
      const ok = gapAccepted(world, node, m, v, approaching, CRITICAL_GAP.permittedLeft, (a) => !control.minorLinks.includes(a.movement.fromLink) && yieldsTo(m, a.movement, conflictKind(node, m, a.movement)));
      if (!ok) return NO('gap');
      if (pedInCrosswalk(node, m, world)) return NO('peds');
      return { go: true, mergeLeader: occ.mergeAhead };
    }
    case 'all-way-stop':
      return allWayStop(world, node, v, m, approaching, occ.mergeAhead);
    case 'roundabout': {
      // Yield on entry to circulating traffic and to vehicles about to enter from the leg on the left
      // (upstream in circulation) that will pass this entry.
      const ok = gapAccepted(world, node, m, v, approaching, CRITICAL_GAP.roundabout, (a) => a.atLine && a.v.speed > 0.5 && roundaboutConflict(m.entryLeg, a.movement) === 'cross' && a.v.id < v.id);
      if (!ok) return NO('gap');
      if (pedInCrosswalk(node, m, world)) return NO('peds');
      return { go: true, mergeLeader: occ.mergeAhead };
    }
  }
  return NO('unknown');
}

function allWayStop(world: World, node: SimNode, v: Vehicle, m: Movement, approaching: Approaching[], mergeAhead: Vehicle | null): EntryDecision {
  if (!v.hasStopped) return NO('stop-first', true);
  // FIFO among stopped vehicles with conflicting movements.
  for (const a of approaching) {
    if (a.v.id === v.id || !a.atLine || !a.v.hasStopped) continue;
    const k = conflictBetween(node, m.key, a.movement.key);
    if (k === 'none') continue;
    if (a.v.stopLineArrival < v.stopLineArrival || (a.v.stopLineArrival === v.stopLineArrival && a.v.id < v.id)) {
      // Earlier arrival goes first — unless priority to the right says otherwise for simultaneous arrivals.
      return NO('awsc-wait');
    }
  }
  if (pedInCrosswalk(node, m, world)) return NO('peds');
  return { go: true, mergeLeader: mergeAhead };
}

function pedKeyFor(node: SimNode, leg: Leg): string {
  return `ped:${leg}`;
}

/** A movement is protected in the current phase if no conflicting movement is also green. */
function isProtected(node: SimNode, m: Movement, sig: SignalView): boolean {
  for (const other of Object.values(node.movements)) {
    if (other.key === m.key) continue;
    if (!sig.green(other.key)) continue;
    const k = conflictBetween(node, m.key, other.key);
    if (k === 'cross') return false;
  }
  return true;
}

function isFreeFlowMovement(node: SimNode, m: Movement): boolean {
  // Interchange: the major road's through movement is on the bridge → free.
  return node.form === 'interchange-terminal' && m.turn === 'T' && (node.conflictOverrides ?? []).some(([a, b]) => a === m.key && b === '*');
}

/** Is there room at the start of the lane the vehicle will enter after the node? */
export function destinationHasRoom(world: World, node: SimNode, v: Vehicle, m: Movement): boolean {
  const lane = destinationLane(world, v, m);
  if (!lane) return false;
  const last = lane.vehicles.length ? world.vehicles[lane.vehicles[lane.vehicles.length - 1]] : null;
  if (!last) return true;
  const rear = posOf(world, last.id) - vehicleLength(last);
  return rear > lane.start + vehicleLength(v) + 1.5;
}

/** Lane on the destination link the vehicle lands in: left → leftmost, right → rightmost, through → same index. */
export function destinationLane(world: World, v: Vehicle, m: Movement) {
  const dest = world.links[m.toLink];
  const general = dest.lanes.filter((l) => l.type === 'general' || (l.type === 'bus' && (v.cls === 'bus' || v.cls === 'emergency')));
  // Prefer a lane that allows the vehicle's *following* turn when the link is short.
  if (!general.length) return null;
  const from = world.links[m.fromLink];
  let idx: number;
  if (m.turn === 'L' || m.turn === 'U') idx = 0;
  else if (m.turn === 'R') idx = general.length - 1;
  else {
    const fromGeneral = from.lanes.filter((l) => l.type === 'general' || l.type === 'bus');
    const curIdx = v.place.kind === 'lane' ? fromGeneral.findIndex((l) => l.id === (v.place as { laneId: string }).laneId) : 0;
    // Through: keep relative position from the left; the lane-drop setting decides which side merges.
    const legOut = world.nodes[dest.from]?.legs.find((l) => l.outLink === dest.id);
    const extra = Math.max(0, fromGeneral.length - general.length);
    idx = legOut?.laneDrop === 'before' ? Math.min(general.length - 1, Math.max(0, curIdx)) : Math.min(general.length - 1, Math.max(0, curIdx - extra + (extra > 0 ? 0 : 0)));
    if (curIdx < 0) idx = Math.min(general.length - 1, 0);
  }
  // Avoid landing in a lane under construction / blocked at its very start.
  const lane = general[idx];
  if (lane.blockedAt !== null && lane.blockedAt < 10 && general.length > 1) return general[idx === 0 ? 1 : idx - 1];
  return lane;
}

export function viewFor(node: SimNode, world: World): SignalView | null {
  return node.control.type === 'signal' ? signalView(node, world) : null;
}

export { lanesAllowing };
