import type { MapDef } from '../network/mapdef.js';
import { tutorialMap } from './tutorial.js';
import { radialMap } from './radial.js';
import { riverMap } from './river.js';

export const MAPS: Record<string, () => MapDef> = { tutorial: tutorialMap, radial: radialMap, river: riverMap };

export function mapByName(name: string): () => MapDef {
  const m = MAPS[name];
  if (!m) throw new Error(`Unknown map ${name}; have ${Object.keys(MAPS).join(', ')}`);
  return m;
}
