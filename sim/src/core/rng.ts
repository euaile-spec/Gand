/** Deterministic seeded RNG (mulberry32). State is a plain number so it survives structuredClone. */
export interface RngState {
  s: number;
}

export function createRng(seed: number): RngState {
  return { s: seed >>> 0 };
}

export function nextFloat(r: RngState): number {
  r.s = (r.s + 0x6d2b79f5) >>> 0;
  let t = r.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function nextRange(r: RngState, lo: number, hi: number): number {
  return lo + (hi - lo) * nextFloat(r);
}

export function nextInt(r: RngState, n: number): number {
  return Math.floor(nextFloat(r) * n);
}

export function chance(r: RngState, p: number): boolean {
  return nextFloat(r) < p;
}

/** Poisson-process arrival: returns true if an event with mean rate `ratePerSec` fires in `dt`. */
export function poissonEvent(r: RngState, ratePerSec: number, dt: number): boolean {
  if (ratePerSec <= 0) return false;
  return nextFloat(r) < 1 - Math.exp(-ratePerSec * dt);
}

export function pick<T>(r: RngState, arr: readonly T[]): T {
  return arr[nextInt(r, arr.length)];
}

/** Weighted pick; weights need not sum to 1. Returns index. */
export function pickWeighted(r: RngState, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return 0;
  let x = nextFloat(r) * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x <= 0) return i;
  }
  return weights.length - 1;
}
