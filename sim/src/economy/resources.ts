/** Lane-km and structure tokens; construction scheduling. */
import type { Construction, World } from '../model/types.js';

export const TOKEN_COST = {
  roundabout: 1,
  oneWay: 1,
  mut: 1,
  rcut: 1,
  cfi: 2,
  frontage: 1,
  interchange: 3,
} as const;

export const POCKET_FREE_TAPER = 30; // metres of pocket that cost nothing

export function laneKmCostForLength(metres: number): number {
  return metres / 1000;
}

export function canAffordLaneKm(world: World, km: number): boolean {
  return world.resources.laneKm + 1e-9 >= km;
}

export function spendLaneKm(world: World, km: number): void {
  world.resources.laneKm -= km;
  world.resources.spentLaneKm += km;
}

export function refundLaneKm(world: World, km: number): void {
  world.resources.laneKm += km;
  world.resources.spentLaneKm = Math.max(0, world.resources.spentLaneKm - km);
}

export function spendTokens(world: World, n: number): boolean {
  if (world.resources.tokens < n) return false;
  world.resources.tokens -= n;
  return true;
}

export function scheduleConstruction(world: World, c: Omit<Construction, 'id' | 'completesAt'>): Construction {
  const days = world.config.constructionDays;
  const built: Construction = { ...c, id: world.nextConstructionId++, completesAt: world.t + days * world.config.dayLength };
  world.constructions.push(built);
  if (c.laneId) {
    const lane = world.lanes[c.laneId];
    if (lane) lane.blockedAt = lane.end - 5;
  }
  if (c.linkId) {
    const link = world.links[c.linkId];
    if (link) link.constructionUntil = built.completesAt;
  }
  return built;
}

/** Weekly allotment and the token-or-lanes choice. */
export function onNewWeek(world: World): void {
  world.resources.laneKm += world.resources.weeklyLaneKm;
  world.resources.pendingWeeklyChoice = true;
}

export function applyWeeklyChoice(world: World, choice: 'token' | 'lanes'): boolean {
  if (!world.resources.pendingWeeklyChoice) return false;
  if (choice === 'token') world.resources.tokens += 1;
  else world.resources.laneKm += world.resources.weeklyLaneKm * 0.6;
  world.resources.pendingWeeklyChoice = false;
  return true;
}

export function hasUnlock(world: World, key: string): boolean {
  return world.resources.unlocks.includes(key) || world.resources.unlocks.includes('*');
}
