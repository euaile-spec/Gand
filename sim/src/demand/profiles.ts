/** Time-of-day demand profiles per land use. tod ∈ [0,1) over the in-game day. */
import type { GeneratorKind, World } from '../model/types.js';

export function timeOfDay(world: World): number {
  const d = world.config.dayLength;
  return ((world.t % d) + d) % d / d;
}

/** Hour of day 0–24 for display. */
export function hourOfDay(world: World): number {
  return timeOfDay(world) * 24;
}

const bump = (tod: number, c: number, w: number, h: number): number => h * Math.exp(-((tod - c) * (tod - c)) / (2 * w * w));

/** Relative trip production (trips leaving) by kind. */
export function production(kind: GeneratorKind, tod: number): number {
  switch (kind) {
    case 'house':
      return 0.15 + bump(tod, 0.33, 0.04, 1.6) + bump(tod, 0.5, 0.08, 0.3) + bump(tod, 0.78, 0.06, 0.5);
    case 'office':
      return 0.05 + bump(tod, 0.52, 0.03, 0.4) + bump(tod, 0.72, 0.04, 1.6);
    case 'shop':
      return 0.1 + bump(tod, 0.52, 0.06, 0.6) + bump(tod, 0.75, 0.07, 0.9);
    case 'school':
      return 0.02 + bump(tod, 0.63, 0.015, 3.0);
    case 'stadium':
      return 0.02;
    case 'hospital':
      return 0.3 + bump(tod, 0.7, 0.05, 0.4);
    case 'depot':
      return 0;
    case 'external':
      return 0.35 + bump(tod, 0.33, 0.05, 1.2) + bump(tod, 0.72, 0.05, 0.9);
  }
}

/** Relative trip attraction (trips arriving) by kind. */
export function attraction(kind: GeneratorKind, tod: number): number {
  switch (kind) {
    case 'house':
      return 0.15 + bump(tod, 0.72, 0.05, 1.5) + bump(tod, 0.55, 0.08, 0.3);
    case 'office':
      return 0.05 + bump(tod, 0.34, 0.035, 1.8) + bump(tod, 0.55, 0.04, 0.4);
    case 'shop':
      return 0.1 + bump(tod, 0.5, 0.06, 0.8) + bump(tod, 0.74, 0.06, 1.0);
    case 'school':
      return 0.02 + bump(tod, 0.33, 0.015, 3.0) + bump(tod, 0.62, 0.015, 2.0);
    case 'stadium':
      return 0.02;
    case 'hospital':
      return 0.3 + bump(tod, 0.4, 0.08, 0.4);
    case 'depot':
      return 0;
    case 'external':
      return 0.35 + bump(tod, 0.33, 0.05, 0.6) + bump(tod, 0.72, 0.05, 1.3);
  }
}

/** Origin–destination affinity: how plausible a trip between kinds is. */
export function affinity(o: GeneratorKind, d: GeneratorKind): number {
  if (o === d && o !== 'external' && o !== 'shop') return 0.2;
  const table: Partial<Record<GeneratorKind, Partial<Record<GeneratorKind, number>>>> = {
    house: { office: 1.4, shop: 1.0, school: 1.2, external: 1.0, hospital: 0.3, stadium: 0.8 },
    office: { house: 1.4, shop: 0.6, external: 1.0, hospital: 0.2 },
    shop: { house: 1.0, office: 0.5, external: 0.5, shop: 0.4 },
    school: { house: 1.5, external: 0.3 },
    stadium: { house: 1.0, external: 1.5 },
    hospital: { house: 0.6, external: 0.6 },
    external: { office: 1.3, shop: 0.8, house: 1.0, external: 0.8, hospital: 0.4, stadium: 1.2, school: 0.4 },
  };
  return table[o]?.[d] ?? 0.5;
}

/** Peak period flags for parking bans: AM 07–09, PM 16–18. */
export function isPeakHour(tod: number): boolean {
  const h = tod * 24;
  return (h >= 7 && h < 9) || (h >= 16 && h < 18);
}
