/**
 * Radial city: an inner square ring around a plaza, four 2+2 spokes out to an outer ring,
 * external gateways beyond. All nodes stay ≤ 4 legs. Jobs inside, homes outside → strongly tidal.
 */
import type { MapDef, MapGeneratorDef, MapNodeDef, MapRoadDef } from '../network/mapdef.js';

export function radialMap(): MapDef {
  const nodes: MapNodeDef[] = [];
  const roads: MapRoadDef[] = [];
  const generators: MapGeneratorDef[] = [];
  const R1 = 120; // inner ring half-size
  const R2 = 360; // outer ring half-size
  const R3 = 520; // gateways

  // Inner ring: i0 (N), i1 (E), i2 (S), i3 (W) at the midpoints of the square's sides.
  const dirs = [
    { id: 'N', x: 0, y: -1 },
    { id: 'E', x: 1, y: 0 },
    { id: 'S', x: 0, y: 1 },
    { id: 'W', x: -1, y: 0 },
  ];
  for (const d of dirs) {
    nodes.push({ id: `i${d.id}`, x: d.x * R1, y: d.y * R1 });
    nodes.push({ id: `o${d.id}`, x: d.x * R2, y: d.y * R2 });
    nodes.push({ id: `x${d.id}`, x: d.x * R3, y: d.y * R3 });
  }
  // Inner ring roads (1+1, parking) go via the square's corners.
  const corner = (a: string, b: string) => {
    const da = dirs.find((d) => d.id === a)!;
    const db = dirs.find((d) => d.id === b)!;
    return { x: (da.x + db.x) * R1, y: (da.y + db.y) * R1 };
  };
  const ring = ['N', 'E', 'S', 'W'];
  for (let k = 0; k < 4; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % 4];
    roads.push({ id: `ir${a}${b}`, a: `i${a}`, b: `i${b}`, via: [corner(a, b)], parkingFwd: 'always', parkingBwd: 'always' });
    const ca = dirs.find((d) => d.id === a)!;
    const cb = dirs.find((d) => d.id === b)!;
    roads.push({ id: `or${a}${b}`, a: `o${a}`, b: `o${b}`, via: [{ x: (ca.x + cb.x) * R2, y: (ca.y + cb.y) * R2 }], parkingFwd: 'always', parkingBwd: 'always' });
  }
  // Spokes: inner→outer 2+2 with median; outer→gateway 2+2.
  for (const d of dirs) {
    roads.push({ id: `sp${d.id}`, a: `i${d.id}`, b: `o${d.id}`, fwdLanes: 2, bwdLanes: 2, median: 'open' });
    roads.push({ id: `gw${d.id}`, a: `o${d.id}`, b: `x${d.id}`, fwdLanes: 2, bwdLanes: 2 });
  }

  // Land use: offices and shops on the inner ring, houses on the outer ring, gateways beyond.
  generators.push({ id: 'offices-ne', kind: 'office', size: 45, roadId: 'irNE', t: 0.5, side: 'fwd' });
  generators.push({ id: 'offices-sw', kind: 'office', size: 40, roadId: 'irSW', t: 0.5, side: 'fwd' });
  generators.push({ id: 'shops-se', kind: 'shop', size: 35, roadId: 'irES', t: 0.5, side: 'bwd' });
  generators.push({ id: 'hospital', kind: 'hospital', size: 25, roadId: 'irWN', t: 0.5, side: 'bwd' });
  generators.push({ id: 'houses-ne', kind: 'house', size: 50, roadId: 'orNE', t: 0.5, side: 'fwd' });
  generators.push({ id: 'houses-es', kind: 'house', size: 50, roadId: 'orES', t: 0.5, side: 'fwd' });
  generators.push({ id: 'houses-sw', kind: 'house', size: 50, roadId: 'orSW', t: 0.5, side: 'fwd' });
  generators.push({ id: 'houses-wn', kind: 'house', size: 50, roadId: 'orWN', t: 0.5, side: 'fwd' });
  generators.push({ id: 'school', kind: 'school', size: 25, roadId: 'spS', t: 0.5, side: 'bwd' });
  generators.push({ id: 'stadium', kind: 'stadium', size: 70, roadId: 'spE', t: 0.6, side: 'fwd', opensDay: 5 });
  for (const d of dirs) generators.push({ id: `gate${d.id}`, kind: 'external', size: 30, roadId: `gw${d.id}`, t: 0.9, side: 'bwd' });

  return {
    name: 'Radial',
    nodes,
    roads,
    generators,
    busRoutes: [
      { id: 'ring', nodes: ['iN', 'iE', 'iS', 'iW'], headway: 240, stops: [{ roadId: 'irNE', t: 0.5, side: 'fwd' }, { roadId: 'irSW', t: 0.5, side: 'fwd' }] },
      { id: 'spokeNS', nodes: ['oN', 'iN', 'iW', 'iS', 'oS', 'oW', 'oN'].slice(0, 6), headway: 360, stops: [{ roadId: 'spN', t: 0.5, side: 'bwd' }, { roadId: 'spS', t: 0.5, side: 'fwd' }] },
    ],
    laneKm: 1.2,
    weeklyLaneKm: 1.2,
  };
}
