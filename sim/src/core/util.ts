export interface Point {
  x: number;
  y: number;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const dist = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);
export const TAU = Math.PI * 2;

/** Angle of vector a→b in radians, screen coordinates (y down), 0 = +x. */
export const heading = (a: Point, b: Point): number => Math.atan2(b.y - a.y, b.x - a.x);

/** Normalise angle to [0, 2π). */
export const normAngle = (a: number): number => ((a % TAU) + TAU) % TAU;

/** Signed smallest difference b−a in (−π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = normAngle(b - a);
  if (d > Math.PI) d -= TAU;
  return d;
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: readonly number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}

export function removeFromArray<T>(arr: T[], v: T): boolean {
  const i = arr.indexOf(v);
  if (i < 0) return false;
  arr.splice(i, 1);
  return true;
}

/** Insert into array keeping sort by key descending. */
export function insertSortedDesc<T>(arr: T[], v: T, key: (x: T) => number): void {
  const k = key(v);
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) > k) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, v);
}

/** Exponentially weighted moving average update. */
export const ewma = (prev: number, sample: number, alpha: number): number => prev + alpha * (sample - prev);

/** Ring buffer of fixed capacity stored as plain data. */
export interface Ring {
  cap: number;
  data: number[];
  head: number; // index of next write
  count: number;
}

export function ringCreate(cap: number): Ring {
  return { cap, data: new Array(cap).fill(0), head: 0, count: 0 };
}

export function ringPush(r: Ring, v: number): void {
  r.data[r.head] = v;
  r.head = (r.head + 1) % r.cap;
  if (r.count < r.cap) r.count++;
}

export function ringToArray(r: Ring): number[] {
  const out: number[] = [];
  const start = (r.head - r.count + r.cap) % r.cap;
  for (let i = 0; i < r.count; i++) out.push(r.data[(start + i) % r.cap]);
  return out;
}

export function ringMax(r: Ring): number {
  let m = -Infinity;
  for (let i = 0; i < r.count; i++) m = Math.max(m, r.data[i]);
  return r.count ? m : 0;
}
