/**
 * Seeded procedural city: a grid with one or two arterials, zoned land use, external gateways,
 * one or two bus loops, and a growth schedule of developments the city adds over time.
 * Same seed → same map, so a date-seeded map serves as the daily challenge.
 */
import { chance, createRng, nextInt, nextRange, pick, type RngState } from '../core/rng.js';
import type { GeneratorKind } from '../model/types.js';
import type { MapDef, MapGeneratorDef, MapGrowthDef, MapNodeDef, MapRoadDef } from '../network/mapdef.js';

export interface ProceduralOptions {
  cols?: number;
  rows?: number;
  block?: number;
  /** Number of growth steps (new developments) over the run. */
  growthSteps?: number;
}

export function proceduralMap(seed: number, opts: ProceduralOptions = {}): MapDef {
  const rng = createRng(seed ^ 0x9e3779b9);
  const cols = opts.cols ?? 3 + nextInt(rng, 3); // 3..5
  const rows = opts.rows ?? 3 + nextInt(rng, 2); // 3..4
  const B = opts.block ?? Math.round(nextRange(rng, 170, 240));
  const nodes: MapNodeDef[] = [];
  const roads: MapRoadDef[] = [];
  const generators: MapGeneratorDef[] = [];
  const growth: MapGrowthDef[] = [];

  // Arterials: one E–W row, and a N–S column on larger maps.
  const artRow = 1 + nextInt(rng, Math.max(1, rows - 2));
  const artCol = cols >= 4 && chance(rng, 0.6) ? 1 + nextInt(rng, cols - 2) : -1;
  const stubLen = 150;

  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) nodes.push({ id: `n${r}${c}`, x: c * B, y: r * B });

  const isArt = (r: number, c: number, horizontal: boolean): boolean => (horizontal ? r === artRow : c === artCol);
  const parkingStyle = (): 'always' | 'none' => (chance(rng, 0.7) ? 'always' : 'none');

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const art = isArt(r, c, true);
      const p = art ? 'none' : parkingStyle();
      roads.push({ id: `h${r}${c}`, a: `n${r}${c}`, b: `n${r}${c + 1}`, fwdLanes: art ? 2 : 1, bwdLanes: art ? 2 : 1, median: art ? (chance(rng, 0.7) ? 'open' : 'twltl') : 'none', parkingFwd: p, parkingBwd: p });
    }
  }
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows - 1; r++) {
      const art = isArt(r, c, false);
      const p = art ? 'none' : parkingStyle();
      roads.push({ id: `v${r}${c}`, a: `n${r}${c}`, b: `n${r + 1}${c}`, fwdLanes: art ? 2 : 1, bwdLanes: art ? 2 : 1, median: art ? 'open' : 'none', parkingFwd: p, parkingBwd: p });
    }
  }

  // Gateways on the arterial ends (always) and a few random edge stubs.
  const gateway = (id: string, x: number, y: number, attach: string, lanes: number, size: number, dir: 'in' | 'out'): void => {
    nodes.push({ id, x, y });
    const roadId = `s${id}`;
    // Road from the stub node into the grid, so 'fwd' side is on the right heading inward.
    roads.push({ id: roadId, a: id, b: attach, fwdLanes: lanes, bwdLanes: lanes });
    generators.push({ id: `g${id}`, kind: 'external', size, roadId, t: 0.1, side: 'fwd' });
    void dir;
  };
  gateway('W', -stubLen, artRow * B, `n${artRow}0`, 2, 45 + nextInt(rng, 25), 'in');
  gateway('E', (cols - 1) * B + stubLen, artRow * B, `n${artRow}${cols - 1}`, 2, 45 + nextInt(rng, 25), 'out');
  if (artCol >= 0) {
    gateway('N', artCol * B, -stubLen, `n0${artCol}`, 2, 25 + nextInt(rng, 15), 'in');
    gateway('S', artCol * B, (rows - 1) * B + stubLen, `n${rows - 1}${artCol}`, 2, 25 + nextInt(rng, 15), 'out');
  }
  const extraGates = 1 + nextInt(rng, 2);
  for (let k = 0; k < extraGates; k++) {
    const side = pick(rng, ['N', 'S'] as const);
    let c = nextInt(rng, cols);
    if (c === artCol) c = (c + 1) % cols;
    const id = `${side}${c}`;
    if (nodes.some((n) => n.id === id)) continue;
    gateway(id, c * B, side === 'N' ? -stubLen : (rows - 1) * B + stubLen, side === 'N' ? `n0${c}` : `n${rows - 1}${c}`, 1, 10 + nextInt(rng, 12), 'in');
  }

  // Land use by zone: homes on the west/north half, offices east/south, shops along the arterial.
  const interior = roads.filter((r) => r.id.startsWith('h') || r.id.startsWith('v'));
  let gi = 0;
  const place = (kind: GeneratorKind, size: number, road: MapRoadDef, opensDay = 0): void => {
    generators.push({ id: `${kind}-${gi++}`, kind, size, roadId: road.id, t: 0.3 + 0.4 * nextRange(rng, 0, 1), side: chance(rng, 0.5) ? 'fwd' : 'bwd', opensDay });
  };
  for (const road of interior) {
    const [r, c] = road.id.startsWith('h') ? [Number(road.id[1]), Number(road.id[2])] : [Number(road.id[1]), Number(road.id[2])];
    const onArterial = road.id.startsWith('h') ? r === artRow : c === artCol;
    const west = c < cols / 2;
    const north = r < rows / 2;
    if (onArterial) {
      if (chance(rng, 0.6)) place('shop', 20 + nextInt(rng, 25), road);
      continue;
    }
    const roll = nextRange(rng, 0, 1);
    if (west || north) {
      if (roll < 0.7) place('house', 25 + nextInt(rng, 30), road);
      else if (roll < 0.85) place('shop', 15 + nextInt(rng, 15), road);
    } else {
      if (roll < 0.65) place('office', 25 + nextInt(rng, 35), road);
      else if (roll < 0.8) place('house', 20 + nextInt(rng, 20), road);
    }
  }
  place('school', 18 + nextInt(rng, 10), pick(rng, interior.filter((r) => !r.id.startsWith(`h${artRow}`))));
  if (chance(rng, 0.6)) place('hospital', 20 + nextInt(rng, 10), pick(rng, interior));
  place('stadium', 50 + nextInt(rng, 30), pick(rng, interior.filter((r) => r.id.startsWith('h') && Number(r.id[1]) !== artRow)), 4 + nextInt(rng, 4));

  // Bus loop around the central block(s) along the arterial.
  const r0 = Math.max(0, Math.min(rows - 2, artRow - (chance(rng, 0.5) ? 1 : 0)));
  const c0 = Math.max(0, Math.min(cols - 3, nextInt(rng, Math.max(1, cols - 2))));
  const loop = [`n${r0}${c0}`, `n${r0}${c0 + 1}`, `n${r0}${c0 + 2}`, `n${r0 + 1}${c0 + 2}`, `n${r0 + 1}${c0 + 1}`, `n${r0 + 1}${c0}`];
  const stopOn = (a: string, b: string): { roadId: string; t: number; side: 'fwd' | 'bwd' } => {
    const road = roads.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a))!;
    return { roadId: road.id, t: 0.5, side: road.a === a ? 'fwd' : 'bwd' };
  };
  const busRoutes = [{ id: 'loop', nodes: loop, headway: 240 + 60 * nextInt(rng, 3), stops: [stopOn(loop[0], loop[1]), stopOn(loop[2], loop[3]), stopOn(loop[3], loop[4]), stopOn(loop[5], loop[0])] }];

  // Growth: developments with their own stub road, attached to edge nodes that still have a free leg.
  const steps = opts.growthSteps ?? 2 + nextInt(rng, 3);
  const edgeNodes = nodes.filter((n) => n.id.startsWith('n') && (Number(n.id[1]) === 0 || Number(n.id[1]) === rows - 1 || Number(n.id[2]) === 0 || Number(n.id[2]) === cols - 1));
  const usedAttach = new Set<string>(roads.filter((r) => r.id.startsWith('s')).map((r) => r.b));
  const legsOf = (id: string): number => roads.filter((r) => r.a === id || r.b === id).length;
  let day = 3;
  for (let k = 0; k < steps; k++) {
    const candidates = edgeNodes.filter((n) => !usedAttach.has(n.id) && legsOf(n.id) < 4);
    if (!candidates.length) break;
    const attach = pick(rng, candidates);
    usedAttach.add(attach.id);
    const r = Number(attach.id[1]);
    const c = Number(attach.id[2]);
    // Direction away from the grid.
    const dx = c === 0 ? -1 : c === cols - 1 ? 1 : 0;
    const dy = dx === 0 ? (r === 0 ? -1 : 1) : 0;
    const nodeId = `d${k}`;
    const roadId = `rd${k}`;
    const kind: GeneratorKind = pick(rng, ['house', 'house', 'office', 'shop', 'shop'] as const);
    growth.push({
      day,
      node: { id: nodeId, x: attach.x + dx * 160, y: attach.y + dy * 160 },
      road: { id: roadId, a: attach.id, b: nodeId, parkingFwd: 'none', parkingBwd: 'none' },
      generator: { id: `${kind}-dev${k}`, kind, size: 30 + nextInt(rng, 40), roadId, t: 0.8, side: 'fwd' },
    });
    day += 2 + nextInt(rng, 3);
  }

  return {
    name: `Procedural #${seed}`,
    nodes,
    roads,
    generators,
    busRoutes,
    growth,
    laneKm: 1.0,
    weeklyLaneKm: 1.0,
    tokens: 0,
  };
}

/** Stable 32-bit hash of a string (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export { createRng as _rng };
export type { RngState };
