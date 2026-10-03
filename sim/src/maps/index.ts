import type { MapDef } from '../network/mapdef.js';
import { tutorialMap } from './tutorial.js';
import { radialMap } from './radial.js';
import { riverMap } from './river.js';
import { proceduralMap } from './procedural.js';

export const MAPS: Record<string, () => MapDef> = { tutorial: tutorialMap, radial: radialMap, river: riverMap, procedural: () => proceduralMap(1) };

export function mapByName(name: string): () => MapDef {
  // "procedural:<seed>" picks a seed.
  if (name.startsWith('procedural:')) {
    const seed = Number(name.split(':')[1]);
    return () => proceduralMap(seed);
  }
  const m = MAPS[name];
  if (!m) throw new Error(`Unknown map ${name}; have ${Object.keys(MAPS).join(', ')}`);
  return m;
}
