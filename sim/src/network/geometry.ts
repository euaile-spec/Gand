/**
 * Node geometry: leg slots, movement derivation, and the conflict matrix.
 *
 * Conflicts use the classic chord model: each leg i sits at angle 90°·i clockwise from north.
 * A vehicle entering from leg i enters the node on the right-hand side of its road
 * (counter-clockwise of the leg centre) and exits a leg on that leg's right-hand side
 * as seen leaving (clockwise of the centre). Two movements cross iff their chords'
 * endpoints interleave on the circle; they merge iff they share an exit point.
 */
import type { ConflictKind, Leg, Movement, NodeLeg, SimNode, Turn, PedCrossing } from '../model/types.js';

const DELTA = 20; // degrees from leg centre to entry/exit point

export const TURN_OFFSET: Record<Turn, number> = { L: 1, T: 2, R: 3, U: 0 };

export function exitLegFor(entry: Leg, turn: Turn): Leg {
  return ((entry + TURN_OFFSET[turn]) % 4) as Leg;
}

export function turnBetween(entry: Leg, exit: Leg): Turn {
  const d = (exit - entry + 4) % 4;
  return d === 1 ? 'L' : d === 2 ? 'T' : d === 3 ? 'R' : 'U';
}

function legAngle(leg: Leg): number {
  return leg * 90;
}

export function entryPoint(leg: Leg): number {
  return (legAngle(leg) - DELTA + 360) % 360;
}

export function exitPoint(leg: Leg): number {
  return (legAngle(leg) + DELTA) % 360;
}

/** Is x strictly inside the clockwise arc from a to b? */
function inArc(a: number, b: number, x: number): boolean {
  const len = (b - a + 360) % 360;
  const off = (x - a + 360) % 360;
  return off > 0 && off < len;
}

function chordsCross(a1: number, a2: number, b1: number, b2: number): boolean {
  const i1 = inArc(a1, a2, b1);
  const i2 = inArc(a1, a2, b2);
  return i1 !== i2;
}

export function movementConflict(a: Movement, b: Movement): ConflictKind {
  if (a.key === b.key) return 'none';
  if (a.entryLeg === b.entryLeg) return 'none'; // same approach: lanes separate them
  if (a.turn === 'U' || b.turn === 'U') {
    // A U-turn sweeps the centre: it crosses the opposite through/left even though it shares their exit.
    const other = a.turn === 'U' ? b : a;
    const u = a.turn === 'U' ? a : b;
    if (other.entryLeg === ((u.entryLeg + 2) % 4) && (other.turn === 'T' || other.turn === 'L')) return 'cross';
  }
  if (a.exitLeg === b.exitLeg) return 'merge';
  // U-turns behave like a left from the same leg for crossing purposes, plus they
  // occupy the centre: treat them as a left turn chord.
  const chord = (m: Movement): [number, number] => {
    const t: Turn = m.turn === 'U' ? 'L' : m.turn;
    return [entryPoint(m.entryLeg), exitPoint(exitLegFor(m.entryLeg, t))];
  };
  const [a1, a2] = chord(a);
  const [b1, b2] = chord(b);
  return chordsCross(a1, a2, b1, b2) ? 'cross' : 'none';
}

export function pedConflict(ped: PedCrossing, m: Movement): ConflictKind {
  if (m.entryLeg === ped.leg) return 'ped-hard';
  if (m.exitLeg === ped.leg) return 'ped-soft';
  return 'none';
}

/**
 * In an uncontrolled / permitted situation, does movement `a` yield to `b`?
 * Rules (right-hand traffic): turning across traffic yields to straight/right; otherwise
 * priority to the right (the approach on your right goes first); a merging right turn
 * yields to the through movement it merges with.
 */
export function yieldsTo(a: Movement, b: Movement, kind: ConflictKind): boolean {
  if (kind === 'none') return false;
  const aTurning = a.turn === 'L' || a.turn === 'U';
  const bTurning = b.turn === 'L' || b.turn === 'U';
  if (aTurning && !bTurning) return true;
  if (!aTurning && bTurning) return false;
  if (kind === 'merge') {
    // Right turn merging into a through exit yields to the through.
    if (a.turn === 'R' && b.turn !== 'R') return true;
    if (b.turn === 'R' && a.turn !== 'R') return false;
  }
  // Priority to the right: approach i yields to approach (i+3)%4.
  if (b.entryLeg === ((a.entryLeg + 3) % 4)) return true;
  if (a.entryLeg === ((b.entryLeg + 3) % 4)) return false;
  // Opposite approaches both turning left: neither strictly; break tie by leg index.
  return a.entryLeg > b.entryLeg;
}

/** Movement path length and speed inside a node of radius r. */
export function movementGeometry(turn: Turn, r: number, linkSpeed: number): { length: number; speed: number } {
  switch (turn) {
    case 'T':
      return { length: 2 * r, speed: linkSpeed };
    case 'L':
      return { length: 1.9 * r, speed: Math.min(linkSpeed, 6.5) };
    case 'R':
      return { length: 0.9 * r, speed: Math.min(linkSpeed, 5.0) };
    case 'U':
      return { length: 2.6 * r, speed: Math.min(linkSpeed, 4.0) };
  }
}

/** Assign incident road headings (radians, screen coords) to the 4 leg slots. */
export function assignLegs(headings: { roadId: string; angle: number }[]): Map<string, Leg> {
  const out = new Map<string, Leg>();
  const taken = new Set<number>();
  // Preferred slot: north = -90°. slot = round((deg + 90)/90) mod 4
  const prefs = headings.map((h) => {
    const deg = ((h.angle * 180) / Math.PI + 360) % 360;
    const raw = (deg + 90) / 90;
    return { roadId: h.roadId, slot: Math.round(raw) % 4, exact: raw };
  });
  // Sort by how close they are to a slot centre so exact fits claim first.
  prefs.sort((p, q) => Math.abs(p.exact - Math.round(p.exact)) - Math.abs(q.exact - Math.round(q.exact)));
  for (const p of prefs) {
    let s = p.slot;
    let tries = 0;
    while (taken.has(s) && tries < 4) {
      s = (s + 1) % 4;
      tries++;
    }
    if (taken.has(s)) throw new Error(`Node has more than 4 legs (road ${p.roadId})`);
    taken.add(s);
    out.set(p.roadId, s as Leg);
  }
  return out;
}

/** Recompute movements, ped crossings and conflicts for a node from its legs and lanes. */
export function rebuildNodeMovements(
  node: SimNode,
  linkSpeed: (linkId: string) => number,
  roadWidth: (roadId: string) => number,
): void {
  const legByIdx = new Map<Leg, NodeLeg>();
  for (const l of node.legs) legByIdx.set(l.leg, l);
  const movements: Record<string, Movement> = {};
  for (const leg of node.legs) {
    if (!leg.inLink) continue;
    for (const turn of ['L', 'T', 'R', 'U'] as Turn[]) {
      const exit = exitLegFor(leg.leg, turn);
      const exitLeg = legByIdx.get(exit);
      if (!exitLeg || !exitLeg.outLink) continue;
      if (turn === 'U' && node.legs.length > 1 && !exitLeg.outLink) continue;
      const key = `${leg.inLink}:${turn}`;
      if (node.banned.includes(key)) continue;
      const g = movementGeometry(turn, node.radius, linkSpeed(leg.inLink));
      movements[key] = { key, fromLink: leg.inLink, toLink: exitLeg.outLink, turn, entryLeg: leg.leg, exitLeg: exit, length: g.length, speed: g.speed };
    }
  }
  node.movements = movements;

  // Pedestrian crossings: one per leg, preserve state.
  const peds: Record<string, PedCrossing> = {};
  for (const leg of node.legs) {
    const key = `ped:${leg.leg}`;
    const prev = node.peds[key];
    const width = roadWidth(leg.roadId);
    peds[key] = prev ? { ...prev, width } : { key, leg: leg.leg, enabled: true, width, waiting: 0, crossingUntil: 0, delayAccum: 0, served: 0 };
  }
  node.peds = peds;

  const conflicts: Record<string, Record<string, ConflictKind>> = {};
  const keys = Object.keys(movements);
  for (const a of keys) {
    conflicts[a] = {};
    for (const b of keys) conflicts[a][b] = movementConflict(movements[a], movements[b]);
    for (const p of Object.values(peds)) conflicts[a][p.key] = pedConflict(p, movements[a]);
  }
  for (const p of Object.values(peds)) {
    conflicts[p.key] = {};
    for (const a of keys) conflicts[p.key][a] = pedConflict(p, movements[a]);
    for (const q of Object.values(peds)) conflicts[p.key][q.key] = 'none';
  }
  // CFI / DDI style overrides: declared pairs no longer conflict.
  if (node.conflictOverrides) {
    for (const [a, b] of node.conflictOverrides) {
      if (conflicts[a]) conflicts[a][b] = 'none';
      if (conflicts[b]) conflicts[b][a] = 'none';
    }
  }
  node.conflicts = conflicts;
}

export function conflictBetween(node: SimNode, a: string, b: string): ConflictKind {
  return node.conflicts[a]?.[b] ?? 'none';
}

export function isHardConflict(k: ConflictKind): boolean {
  return k === 'cross' || k === 'ped-hard';
}
