/** Intelligent Driver Model car-following. */
import type { VehicleParams } from '../model/types.js';

/**
 * @param v own speed, @param v0 desired speed, @param gap distance to leader rear (m),
 * @param dv speed difference own − leader (m/s)
 */
export function idmAccel(p: VehicleParams, v: number, v0: number, gap: number, dv: number): number {
  const a = p.maxAccel;
  const b = p.comfortDecel;
  const s = Math.max(gap, 0.1);
  const sStar = p.minGap + Math.max(0, v * p.headway + (v * dv) / (2 * Math.sqrt(a * b)));
  const free = v0 > 0 ? Math.pow(v / v0, 4) : 1;
  const acc = a * (1 - free - (sStar / s) * (sStar / s));
  // Cap emergency braking to something physical.
  return Math.max(acc, -8);
}

/** Free-road acceleration (no leader). */
export function idmFree(p: VehicleParams, v: number, v0: number): number {
  return p.maxAccel * (1 - (v0 > 0 ? Math.pow(v / v0, 4) : 1));
}

/** Can the vehicle stop before `distance` with comfortable deceleration? */
export function canStopWithin(v: number, distance: number, decel: number): boolean {
  return (v * v) / (2 * decel) <= distance;
}
