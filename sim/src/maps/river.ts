/**
 * River city: homes on the west bank, jobs on the east bank, three bridges. The middle bridge is
 * 2+2; the others 1+1 and long. Bridges are where metering, tidal flow and one-way conversions pay.
 */
import type { MapDef, MapGeneratorDef, MapNodeDef, MapRoadDef } from '../network/mapdef.js';

export function riverMap(): MapDef {
  const nodes: MapNodeDef[] = [];
  const roads: MapRoadDef[] = [];
  const generators: MapGeneratorDef[] = [];
  const B = 220;
  const GAP = 320; // river width between bank roads

  // West bank columns x = 0, B ; east bank columns x = B+GAP, 2B+GAP. Rows r = 0..2.
  const wx = [0, B];
  const ex = [B + GAP, 2 * B + GAP];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 2; c++) {
      nodes.push({ id: `w${r}${c}`, x: wx[c], y: r * B });
      nodes.push({ id: `e${r}${c}`, x: ex[c], y: r * B });
    }
  }
  // Bank grids
  for (let r = 0; r < 3; r++) {
    roads.push({ id: `wh${r}`, a: `w${r}0`, b: `w${r}1`, parkingFwd: 'always', parkingBwd: 'always' });
    roads.push({ id: `eh${r}`, a: `e${r}0`, b: `e${r}1`, parkingFwd: 'always', parkingBwd: 'always' });
  }
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      // Riverside roads (c=1 west, c=0 east) are 2+2 collectors feeding the bridges.
      const westRiverside = c === 1;
      const eastRiverside = c === 0;
      roads.push({ id: `wv${r}${c}`, a: `w${r}${c}`, b: `w${r + 1}${c}`, fwdLanes: westRiverside ? 2 : 1, bwdLanes: westRiverside ? 2 : 1, parkingFwd: westRiverside ? 'none' : 'always', parkingBwd: westRiverside ? 'none' : 'always' });
      roads.push({ id: `ev${r}${c}`, a: `e${r}${c}`, b: `e${r + 1}${c}`, fwdLanes: eastRiverside ? 2 : 1, bwdLanes: eastRiverside ? 2 : 1, parkingFwd: eastRiverside ? 'none' : 'always', parkingBwd: eastRiverside ? 'none' : 'always' });
    }
  }
  // Bridges
  roads.push({ id: 'bridgeN', a: 'w01', b: 'e00' });
  roads.push({ id: 'bridgeM', a: 'w11', b: 'e10', fwdLanes: 2, bwdLanes: 2, median: 'closed' });
  roads.push({ id: 'bridgeS', a: 'w21', b: 'e20' });
  // Gateways
  nodes.push({ id: 'xW1', x: -160, y: B });
  nodes.push({ id: 'xE1', x: 2 * B + GAP + 160, y: B });
  nodes.push({ id: 'xN', x: ex[1], y: -160 });
  nodes.push({ id: 'xS', x: wx[0], y: 2 * B + 160 });
  roads.push({ id: 'gW', a: 'xW1', b: 'w10', fwdLanes: 2, bwdLanes: 2 });
  roads.push({ id: 'gE', a: 'e11', b: 'xE1', fwdLanes: 2, bwdLanes: 2 });
  roads.push({ id: 'gN', a: 'xN', b: 'e01' });
  roads.push({ id: 'gS', a: 'w20', b: 'xS' });

  // Homes west, jobs east.
  generators.push({ id: 'houses-w0', kind: 'house', size: 45, roadId: 'wh0', t: 0.5, side: 'fwd' });
  generators.push({ id: 'houses-w1', kind: 'house', size: 55, roadId: 'wh1', t: 0.5, side: 'bwd' });
  generators.push({ id: 'houses-w2', kind: 'house', size: 45, roadId: 'wh2', t: 0.5, side: 'fwd' });
  generators.push({ id: 'houses-w3', kind: 'house', size: 35, roadId: 'wv00', t: 0.5, side: 'fwd' });
  generators.push({ id: 'school-w', kind: 'school', size: 25, roadId: 'wv10', t: 0.5, side: 'bwd' });
  generators.push({ id: 'shops-w', kind: 'shop', size: 25, roadId: 'wv01', t: 0.4, side: 'bwd' });
  generators.push({ id: 'offices-e0', kind: 'office', size: 55, roadId: 'eh0', t: 0.5, side: 'bwd' });
  generators.push({ id: 'offices-e1', kind: 'office', size: 70, roadId: 'eh1', t: 0.5, side: 'fwd' });
  generators.push({ id: 'offices-e2', kind: 'office', size: 45, roadId: 'eh2', t: 0.5, side: 'bwd' });
  generators.push({ id: 'shops-e', kind: 'shop', size: 40, roadId: 'ev11', t: 0.5, side: 'fwd' });
  generators.push({ id: 'hospital-e', kind: 'hospital', size: 25, roadId: 'ev01', t: 0.5, side: 'bwd' });
  generators.push({ id: 'mall-e', kind: 'shop', size: 50, roadId: 'ev10', t: 0.6, side: 'fwd', opensDay: 6 });
  generators.push({ id: 'gateW', kind: 'external', size: 40, roadId: 'gW', t: 0.1, side: 'fwd' });
  generators.push({ id: 'gateE', kind: 'external', size: 40, roadId: 'gE', t: 0.9, side: 'bwd' });
  generators.push({ id: 'gateN', kind: 'external', size: 20, roadId: 'gN', t: 0.1, side: 'fwd' });
  generators.push({ id: 'gateS', kind: 'external', size: 20, roadId: 'gS', t: 0.9, side: 'bwd' });

  return {
    name: 'River',
    nodes,
    roads,
    generators,
    busRoutes: [
      { id: 'cross', nodes: ['w10', 'w11', 'e10', 'e11', 'e21', 'e20', 'w21', 'w20'], headway: 300, stops: [{ roadId: 'wh1', t: 0.5, side: 'fwd' }, { roadId: 'eh1', t: 0.5, side: 'fwd' }, { roadId: 'eh2', t: 0.5, side: 'bwd' }, { roadId: 'wh2', t: 0.5, side: 'bwd' }] },
    ],
    laneKm: 1.5,
    weeklyLaneKm: 1.2,
  };
}
