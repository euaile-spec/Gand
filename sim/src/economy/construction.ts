/** Completing scheduled constructions. Payload application is registered by the editor to avoid cycles. */
import type { Construction, World } from '../model/types.js';
import { recomputeBlockages } from '../incidents/incidents.js';

type Applier = (world: World, c: Construction) => void;
let applier: Applier | null = null;

export function registerConstructionApplier(fn: Applier): void {
  applier = fn;
}

export function completeConstructions(world: World): void {
  if (!world.constructions.length) return;
  const done = world.constructions.filter((c) => c.completesAt <= world.t);
  if (!done.length) return;
  world.constructions = world.constructions.filter((c) => c.completesAt > world.t);
  for (const c of done) {
    if (c.linkId) {
      const link = world.links[c.linkId];
      if (link && link.constructionUntil <= world.t) link.constructionUntil = 0;
    }
    applier?.(world, c);
  }
  recomputeBlockages(world);
}
