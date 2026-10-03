/** Shared stall diagnostics for the CLI tools. */
import type { World } from '../model/types.js';
import { nextMovement } from '../traffic/access.js';
import { approachingVehicles, lastGapThreat, mayEnter, viewFor } from '../control/manager.js';

export function debugDump(w: World): void {
  for (const node of Object.values(w.nodes)) {
    const occ = node.occupants.map((id) => w.vehicles[id]).filter(Boolean);
    const stuck = occ.filter((v) => v.speed < 0.3 && w.t - v.nodeEnterTime > 5);
    if (stuck.length) console.log(`  node ${node.id} box-blocked (${node.metrics.boxBlockedFor.toFixed(0)}s): ${stuck.map((v) => { const m = node.movements[(v.place as { movement: string }).movement]; const dest = m ? w.links[m.toLink] : null; const lanes = dest ? dest.lanes.map((l) => `${l.id}:${l.vehicles.length}${l.blockedAt !== null ? 'B' : ''}`).join(' ') : ''; return `${v.id}@${(v.place as { movement: string }).movement} pos=${(v.place as { pos: number }).pos.toFixed(1)}/${m?.length.toFixed(0)} dest[${lanes}]`; }).join(', ')}`);
  }
  for (const lane of Object.values(w.lanes)) {
    if (!lane.vehicles.length) continue;
    const front = w.vehicles[lane.vehicles[0]];
    const link = w.links[lane.linkId];
    if (front && front.speed < 0.3 && front.place.kind === 'lane') {
      const node = w.nodes[link.to];
      const m = nextMovement(w, front);
      const dec = m ? mayEnter(w, node, front, m, approachingVehicles(w, node), viewFor(node, w)) : null;
      console.log(
        `  lane ${lane.id} front ${front.id} pos=${front.place.pos.toFixed(1)}/${link.length.toFixed(0)} wait=${front.stopLineArrival ? (w.t - front.stopLineArrival).toFixed(0) : '-'}s route ${front.route.slice(front.routeIdx, front.routeIdx + 2).join('→')} turn=${m?.turn ?? '-'} allowed=${lane.allowed.join('')} q=${lane.vehicles.length} pat=${front.patience.toFixed(2)} dest=${front.destPos?.toFixed(0) ?? '-'} dec=${dec ? (dec.go ? 'go' : dec.reason) : 'none'}${dec && !dec.go && dec.reason === 'gap' ? ` [${lastGapThreat}]` : ''} ctrl=${node.control.type}`,
      );
    }
  }
}

