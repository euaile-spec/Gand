/** Tutorial city: a 3×3 grid, 200 m blocks, one 2+2 E–W arterial through the middle row. */
import type { MapDef, MapGeneratorDef, MapNodeDef, MapRoadDef } from '../network/mapdef.js';

export function tutorialMap(): MapDef {
  const B = 200;
  const nodes: MapNodeDef[] = [];
  const roads: MapRoadDef[] = [];
  const generators: MapGeneratorDef[] = [];

  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) nodes.push({ id: `n${r}${c}`, x: c * B, y: r * B });

  // External stubs on all four sides
  for (let c = 0; c < 3; c++) {
    nodes.push({ id: `xN${c}`, x: c * B, y: -150 });
    nodes.push({ id: `xS${c}`, x: c * B, y: 2 * B + 150 });
    roads.push({ id: `sN${c}`, a: `xN${c}`, b: `n0${c}` });
    roads.push({ id: `sS${c}`, a: `n2${c}`, b: `xS${c}` });
  }
  for (let r = 0; r < 3; r++) {
    const arterial = r === 1;
    nodes.push({ id: `xW${r}`, x: -150, y: r * B });
    nodes.push({ id: `xE${r}`, x: 2 * B + 150, y: r * B });
    roads.push({ id: `sW${r}`, a: `xW${r}`, b: `n${r}0`, fwdLanes: arterial ? 2 : 1, bwdLanes: arterial ? 2 : 1 });
    roads.push({ id: `sE${r}`, a: `n${r}2`, b: `xE${r}`, fwdLanes: arterial ? 2 : 1, bwdLanes: arterial ? 2 : 1 });
  }

  // Grid roads. Row 1 is the arterial (2+2, open median). Others are 1+1 with parking.
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 2; c++) {
      const arterial = r === 1;
      roads.push({
        id: `h${r}${c}`,
        a: `n${r}${c}`,
        b: `n${r}${c + 1}`,
        fwdLanes: arterial ? 2 : 1,
        bwdLanes: arterial ? 2 : 1,
        median: arterial ? 'open' : 'none',
        parkingFwd: arterial ? 'none' : 'always',
        parkingBwd: arterial ? 'none' : 'always',
      });
    }
  }
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 2; r++) {
      roads.push({ id: `v${r}${c}`, a: `n${r}${c}`, b: `n${r + 1}${c}`, parkingFwd: 'always', parkingBwd: 'always' });
    }
  }

  // External gateways: big producers/attractors at the edges.
  const ext = (id: string, roadId: string, t: number, side: 'fwd' | 'bwd', size: number) => generators.push({ id, kind: 'external', size, roadId, t, side });
  ext('gW1', 'sW1', 0.1, 'fwd', 60);
  ext('gE1', 'sE1', 0.9, 'bwd', 60);
  ext('gN1', 'sN1', 0.1, 'fwd', 25);
  ext('gS1', 'sS1', 0.9, 'bwd', 25);
  ext('gW0', 'sW0', 0.1, 'fwd', 12);
  ext('gE2', 'sE2', 0.9, 'bwd', 12);

  // Local land use
  generators.push({ id: 'houses-nw', kind: 'house', size: 30, roadId: 'h00', t: 0.5, side: 'bwd' });
  generators.push({ id: 'houses-w', kind: 'house', size: 25, roadId: 'v10', t: 0.5, side: 'fwd' });
  generators.push({ id: 'houses-sw', kind: 'house', size: 30, roadId: 'h20', t: 0.4, side: 'fwd' });
  generators.push({ id: 'houses-s', kind: 'house', size: 20, roadId: 'v11', t: 0.5, side: 'bwd' });
  generators.push({ id: 'offices-ne', kind: 'office', size: 35, roadId: 'h01', t: 0.5, side: 'bwd' });
  generators.push({ id: 'offices-e', kind: 'office', size: 30, roadId: 'v02', t: 0.5, side: 'fwd' });
  generators.push({ id: 'shops-centre', kind: 'shop', size: 25, roadId: 'h10', t: 0.6, side: 'fwd' });
  generators.push({ id: 'shops-centre2', kind: 'shop', size: 20, roadId: 'h11', t: 0.4, side: 'bwd' });
  generators.push({ id: 'school', kind: 'school', size: 20, roadId: 'v01', t: 0.5, side: 'bwd' });
  generators.push({ id: 'stadium', kind: 'stadium', size: 60, roadId: 'h21', t: 0.5, side: 'fwd', opensDay: 4 });
  generators.push({ id: 'mall', kind: 'shop', size: 40, roadId: 'h11', t: 0.7, side: 'fwd', opensDay: 7 });

  return {
    name: 'Tutorial',
    nodes,
    roads,
    generators,
    busRoutes: [
      {
        id: 'bus1',
        nodes: ['n10', 'n11', 'n12', 'n22', 'n21', 'n20'],
        headway: 300,
        stops: [
          { roadId: 'h10', t: 0.5, side: 'fwd' },
          { roadId: 'h11', t: 0.5, side: 'fwd' },
          { roadId: 'h21', t: 0.5, side: 'bwd' },
          { roadId: 'h20', t: 0.5, side: 'bwd' },
        ],
      },
    ],
    laneKm: 1.0,
    weeklyLaneKm: 1.0,
    tokens: 0,
  };
}
