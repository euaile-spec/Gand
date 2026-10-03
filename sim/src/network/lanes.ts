/** Lane and link helpers shared by the builder, editor and traffic sim. */
import {
  LANE_WIDTH_NARROW,
  LANE_WIDTH_STANDARD,
  SAT_FLOW_BASE,
  type Lane,
  type LaneId,
  type Link,
  type LinkId,
  type Turn,
  type World,
} from '../model/types.js';

export const KMH = (v: number): number => v / 3.6;

export function laneIdFor(linkId: LinkId, index: number | 'pL' | 'pR' | `bay${number}`): LaneId {
  return `${linkId}#${index}`;
}

export function makeLane(linkId: LinkId, index: number, type: Lane['type'], start: number, end: number, allowed: Turn[], width = LANE_WIDTH_STANDARD): Lane {
  const id = typeof index === 'number' && type !== 'pocket' && type !== 'bay' ? laneIdFor(linkId, index) : laneIdFor(linkId, type === 'pocket' ? (index < 0 ? 'pL' : 'pR') : (`bay${index}` as `bay${number}`));
  return { id, linkId, index, type, start, end, width, allowed, vehicles: [], blockedAt: null };
}

/** Drivable lanes for general traffic (excludes parking); includes bus lanes (buses only decide later). */
export function drivableLanes(link: Link): Lane[] {
  return link.lanes.filter((l) => l.type === 'general' || l.type === 'bus');
}

export function generalLanes(link: Link): Lane[] {
  return link.lanes.filter((l) => l.type === 'general');
}

export function allTrafficLanes(link: Link): Lane[] {
  const out = drivableLanes(link);
  if (link.pocketLeft) out.unshift(link.pocketLeft);
  if (link.pocketRight) out.push(link.pocketRight);
  out.push(...link.bays);
  return out;
}

/** Default turn permissions for n general lanes: left lane gets L(+U), right lane gets R, all get T. */
export function defaultAllowed(n: number, i: number): Turn[] {
  if (n <= 1) return ['L', 'T', 'R', 'U'];
  if (i === 0) return ['L', 'T', 'U'];
  if (i === n - 1) return ['T', 'R'];
  return ['T'];
}

/** Lanes of `link` that may perform `turn` at the downstream node, including pockets. */
export function lanesAllowing(link: Link, turn: Turn, cls: 'car' | 'bus' | 'truck' | 'emergency' = 'car'): Lane[] {
  return allTrafficLanes(link).filter((l) => {
    if (l.type === 'bay') return false;
    if (l.type === 'bus' && cls !== 'bus' && cls !== 'emergency') {
      // Cars may use an unprotected bus lane only to turn right.
      return !l.protectedBus && turn === 'R' && l.allowed.includes('R');
    }
    return l.allowed.includes(turn);
  });
}

/** Saturation flow (veh/h) for a lane given width and world weather. */
export function laneSatFlow(lane: Lane, world: World): number {
  const widthFactor = lane.width >= LANE_WIDTH_STANDARD ? 1 : lane.width <= LANE_WIDTH_NARROW ? 0.9 : 0.95;
  const wear = world.links[lane.linkId]?.wear ?? 0;
  return SAT_FLOW_BASE * widthFactor * world.satFlowFactor * (1 - 0.15 * wear);
}

/** Design speed from cross-section: 50 km/h standard, slower for narrow lanes and parking. */
export function designSpeed(link: Link): number {
  let v = 50;
  const gen = drivableLanes(link);
  if (gen.length && gen.every((l) => l.width <= LANE_WIDTH_NARROW)) v -= 10;
  if (link.parking !== 'none') v -= 10;
  if (link.curbExtensions) v -= 5;
  if (link.bridge) v = 80;
  return KMH(Math.max(30, v));
}

export function refreshLinkSpeed(world: World, link: Link): void {
  link.designSpeed = designSpeed(link);
  link.speedLimit = link.designSpeed;
  link.freeFlowTime = link.length / link.speedLimit;
  if (!link.travelTime) link.travelTime = link.freeFlowTime;
}

export function laneLength(lane: Lane): number {
  return lane.end - lane.start;
}

/** Adjacent lane (toward index `dir` = -1 left / +1 right) among drivable+pocket lanes. */
export function neighbourLane(link: Link, lane: Lane, dir: -1 | 1): Lane | null {
  const ordered = allTrafficLanes(link).filter((l) => l.type !== 'bay');
  const i = ordered.indexOf(lane);
  // A vehicle stranded on a lane that is no longer drivable (e.g. parking after a peak ban ends)
  // or in a bay can only move toward the rightmost drivable lane.
  if (i < 0) return dir === -1 ? ordered[ordered.length - 1] ?? null : null;
  const j = i + dir;
  if (j < 0 || j >= ordered.length) return null;
  return ordered[j];
}

export function laneOf(world: World, id: LaneId): Lane {
  const l = world.lanes[id];
  if (!l) throw new Error(`Unknown lane ${id}`);
  return l;
}

export function linkOf(world: World, id: LinkId): Link {
  const l = world.links[id];
  if (!l) throw new Error(`Unknown link ${id}`);
  return l;
}

/** Register a lane in the world index. */
export function indexLane(world: World, lane: Lane): void {
  world.lanes[lane.id] = lane;
}

export function unindexLane(world: World, lane: Lane): void {
  delete world.lanes[lane.id];
}

/** Reverse link id for a road link (null if one-way). */
export function reverseLinkId(world: World, linkId: LinkId): LinkId | null {
  const link = world.links[linkId];
  const other = linkId.endsWith('>') ? `${link.roadId}<` : `${link.roadId}>`;
  return world.links[other] ? other : null;
}

export function isForwardLink(linkId: LinkId): boolean {
  return linkId.endsWith('>');
}
