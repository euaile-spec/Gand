/**
 * Playtest bot: a reactive traffic engineer that reads the instruments and applies the fixes a
 * competent player would. Used to validate that the instruments point at the right fix and to
 * balance resources. Every action is logged with its reason.
 */
import type { Game } from '../game/game.js';
import type { Command } from '../editor/commands.js';
import type { Lane, LinkId, NodeId, SimNode, World } from '../model/types.js';
import { generalLanes } from '../network/lanes.js';
import { queueLength } from '../traffic/access.js';
import { POCKET_FREE_TAPER, laneKmCostForLength } from '../economy/resources.js';
import { offsetIntersections, storageReport } from '../metrics/instruments.js';

export interface BotAction {
  t: number;
  day: number;
  cmd: Command;
  reason: string;
  ok: boolean;
  error?: string;
}

export interface BotOptions {
  /** Seconds between policy evaluations. */
  interval: number;
  /** Max actions per evaluation. */
  maxActions: number;
  /** Cooldown per node/link between structural edits. */
  cooldown: number;
  verbose: boolean;
  /** Command types the bot must never use (ablation). */
  disabled: string[];
}

const DEFAULTS: BotOptions = { interval: 600, maxActions: 2, cooldown: 1800, verbose: false, disabled: [] };

export class EngineerBot {
  readonly log: BotAction[] = [];
  private lastEdit = new Map<string, number>();
  private nextEval = 0;
  readonly opts: BotOptions;

  constructor(readonly game: Game, opts: Partial<BotOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Call after each advance; evaluates the policy when due. */
  tick(): void {
    const w = this.game.world;
    if (w.t < this.nextEval) return;
    this.nextEval = w.t + this.opts.interval;
    this.evaluate();
  }

  private act(cmd: Command, reason: string, key?: string): boolean {
    if (this.opts.disabled.includes(cmd.type)) return false;
    const r = this.game.apply(cmd);
    const w = this.game.world;
    this.log.push({ t: w.t, day: w.day, cmd, reason, ok: r.ok, error: r.ok ? undefined : r.error });
    if (this.opts.verbose) console.log(`  [bot d${w.day} ${(w.t % w.config.dayLength / w.config.dayLength * 24).toFixed(1)}h] ${r.ok ? 'OK ' : 'ERR'} ${cmd.type} — ${reason}${r.ok ? '' : ` (${r.error})`}`);
    if (r.ok && key) this.lastEdit.set(key, w.t);
    return r.ok;
  }

  private cool(key: string): boolean {
    const last = this.lastEdit.get(key);
    return last === undefined || this.game.world.t - last > this.opts.cooldown;
  }

  private evaluate(): void {
    const w = this.game.world;
    let actions = 0;
    const budget = (): boolean => actions < this.opts.maxActions;

    // 0. Housekeeping: weekly choice, signal faults.
    if (w.resources.pendingWeeklyChoice) {
      const choice = w.resources.laneKm > 1.5 ? 'token' : 'lanes';
      this.act({ type: 'weeklyChoice', choice }, `weekly choice: ${choice} (unspent lane-km ${w.resources.laneKm.toFixed(2)})`);
    }
    for (const n of Object.values(w.nodes)) {
      if (n.control.runtime?.malfunction && budget()) {
        if (this.act({ type: 'resetSignal', nodeId: n.id }, 'signal fault')) actions++;
      }
    }

    // Rank nodes by trouble: worst v/c and LOS.
    const nodes = Object.values(w.nodes)
      .map((n) => ({ n, worst: worstMovement(n) }))
      .filter((x) => x.worst)
      .sort((a, b) => b.worst!.vc - a.worst!.vc);

    for (const { n, worst } of nodes) {
      if (!budget()) break;
      if (!worst) continue;
      const m = n.movements[worst.key];
      if (!m) continue;
      const link = w.links[m.fromLink];
      const total = Object.values(n.metrics.demand).reduce((s, d) => s + d, 0);

      // 1. Uncontrolled node getting busy → signal with actuation and detectors.
      if (n.control.type === 'uncontrolled' && (total > 900 || worst.vc > 1.0 || n.metrics.conflictScore > 0.8 || n.metrics.crashes >= 2) && this.cool(n.id)) {
        if (this.act({ type: 'setControl', nodeId: n.id, control: 'signal' }, `uncontrolled, demand ${total.toFixed(0)} veh/h, worst v/c ${worst.vc.toFixed(2)} on ${worst.key}, conflict ${n.metrics.conflictScore.toFixed(2)}, crashes ${n.metrics.crashes}`, n.id)) {
          actions++;
          this.act({ type: 'setCycle', nodeId: n.id, cycle: 60 }, 'start with a short cycle');
          this.act({ type: 'setActuated', nodeId: n.id, on: true }, 'actuate so empty phases are skipped');
          this.act({ type: 'setDetectors', nodeId: n.id, detectors: detectorsFor(w, n) }, 'stop-bar + advance detectors on every approach');
        }
        continue;
      }
      // 1a. A two-way stop whose minor street is starving → signal.
      if (n.control.type === 'two-way-stop' && worst.vc > 0.9 && n.control.minorLinks.includes(m.fromLink) && this.cool(n.id)) {
        if (this.act({ type: 'setControl', nodeId: n.id, control: 'signal' }, `minor street starving at the stop sign: v/c ${worst.vc.toFixed(2)} on ${worst.key}`, n.id)) {
          actions++;
          this.act({ type: 'setCycle', nodeId: n.id, cycle: 60 }, 'short cycle');
          this.act({ type: 'setActuated', nodeId: n.id, on: true }, 'actuated');
          this.act({ type: 'setDetectors', nodeId: n.id, detectors: detectorsFor(w, n) }, 'detectors');
        }
        continue;
      }
      // 1b. Minor crossing of an arterial with low minor demand → two-way stop instead of free-for-all.
      if (n.control.type === 'uncontrolled' && total > 300 && this.cool(n.id)) {
        const [majorLinks] = splitByPair(w, n);
        const minorDemand = Object.values(n.movements).filter((mm) => !majorLinks.includes(mm.fromLink)).reduce((s, mm) => s + (n.metrics.demand[mm.key] ?? 0), 0);
        if (minorDemand < total * 0.3) {
          if (this.act({ type: 'setControl', nodeId: n.id, control: 'two-way-stop' }, `minor street carries ${(minorDemand / Math.max(1, total) * 100).toFixed(0)}% of demand`, n.id)) actions++;
          continue;
        }
      }

      if (n.control.type !== 'signal' || !n.control.signal) continue;
      const plan = n.control.signal;

      // 2. Left turn saturated: pocket + protected phase.
      if ((m.turn === 'L' || m.turn === 'U') && worst.vc > 0.9 && this.cool(`${link.id}:pocket`)) {
        const general = generalLanes(link);
        if (!link.pocketLeft && general.length >= 2) {
          const road = w.roads[link.roadId];
          const source = road.median !== 'none' ? 'median' : 'narrow';
          const storage = Math.min(80, link.length - 50);
          if (affordPocket(w, storage) && this.act({ type: 'setPocket', linkId: link.id, spec: { side: 'left', storage, source } }, `left v/c ${worst.vc.toFixed(2)} on ${worst.key}: add ${storage} m pocket`, `${link.id}:pocket`)) {
            actions++;
            this.act({ type: 'setLeftTreatment', nodeId: n.id, linkId: link.id, treatment: 'protected-permitted' }, 'protect the left now that it has its own lane');
            continue;
          }
        } else if (link.pocketLeft && (plan.leftTreatment[link.id] ?? 'permitted') === 'permitted') {
          if (this.act({ type: 'setLeftTreatment', nodeId: n.id, linkId: link.id, treatment: 'protected-permitted' }, `left v/c ${worst.vc.toFixed(2)}: protect it`, `${link.id}:pocket`)) {
            actions++;
            continue;
          }
        }
      }
      // 3. Pocket overflow: queue reaches the pocket entry → lengthen it.
      if (link.pocketLeft && this.cool(`${link.id}:pocket`)) {
        const storage = link.pocketLeft.end - link.pocketLeft.start;
        if (queueLength(w, link.pocketLeft) >= storage * 0.9 && storage + 30 < link.length - 50 && affordPocket(w, storage + 30)) {
          const road = w.roads[link.roadId];
          if (this.act({ type: 'setPocket', linkId: link.id, spec: { side: 'left', storage: storage + 30, source: road.median !== 'none' ? 'median' : 'narrow' } }, `left pocket on ${link.id} overflowing (${storage} m): extend`, `${link.id}:pocket`)) {
            actions++;
            continue;
          }
        }
      }
      // 4. Through saturated: give its phase more green, or lengthen the cycle.
      if (m.turn === 'T' && worst.vc > 0.95 && this.cool(`${n.id}:split`)) {
        const idx = plan.phases.findIndex((p) => p.movements.includes(m.key));
        if (idx >= 0) {
          if (plan.cycle < 110) {
            if (this.act({ type: 'setSplit', nodeId: n.id, phaseIndex: idx, split: plan.phases[idx].split + 6 }, `through v/c ${worst.vc.toFixed(2)} on ${worst.key}: +6 s green`, `${n.id}:split`)) actions++;
          } else if (plan.cycle < 150) {
            if (this.act({ type: 'setCycle', nodeId: n.id, cycle: plan.cycle + 15 }, `through v/c ${worst.vc.toFixed(2)}, cycle ${plan.cycle.toFixed(0)} s: lengthen`, `${n.id}:split`)) actions++;
          }
          continue;
        }
      }
      // 5. Right turns saturated with peds → slip lane.
      if (m.turn === 'R' && worst.vc > 0.9 && !m.slip && this.cool(`${link.id}:slip`) && w.resources.laneKm > 0.1) {
        const leg = n.legs.find((l) => l.inLink === link.id);
        if (leg && this.act({ type: 'setChannelisedRight', nodeId: n.id, leg: leg.leg, on: true }, `right v/c ${worst.vc.toFixed(2)} on ${worst.key}: slip lane`, `${link.id}:slip`)) {
          actions++;
          continue;
        }
      }
    }

    // Construction discipline: one site at a time, never started in a peak (closures bite then).
    const hour = ((w.t % w.config.dayLength) / w.config.dayLength) * 24;
    const peak = (hour >= 6.5 && hour < 9.5) || (hour >= 15.5 && hour < 18.5);
    const canBuild = w.constructions.length === 0 && !peak;

    // 6. Corridor capacity: widen the single-lane link with the worst persistent delay, if affordable.
    if (budget() && w.resources.laneKm > 0.15 && canBuild) {
      const candidates = Object.values(w.links)
        .filter((l) => generalLanes(l).length === 1 && l.constructionUntil === 0 && this.cool(`${l.roadId}:widen`))
        .map((l) => ({ l, delay: w.metrics.linkDelay[l.id] ?? 0 }))
        .sort((a, b) => b.delay - a.delay);
      const top = candidates[0];
      if (top && top.delay > 25) {
        const dir = top.l.id.endsWith('>') ? 'fwd' : 'bwd';
        // Free first: a peak ban, then full parking removal, before spending lane-km.
        if (top.l.parking === 'always') {
          if (this.act({ type: 'setParking', linkId: top.l.id, mode: 'peak-ban' }, `link delay ${top.delay.toFixed(0)} s on ${top.l.id}: peak-hour parking ban`, `${top.l.roadId}:widen`)) actions++;
        } else if (top.l.parking === 'peak-ban') {
          if (this.act({ type: 'setParking', linkId: top.l.id, mode: 'none' }, `link delay ${top.delay.toFixed(0)} s on ${top.l.id} despite peak ban: remove parking`, `${top.l.roadId}:widen`)) actions++;
        } else {
          const km = laneKmCostForLength(top.l.length);
          if (w.resources.laneKm >= km && this.act({ type: 'widen', roadId: top.l.roadId, dir }, `link delay ${top.delay.toFixed(0)} s on ${top.l.id}: widen (${km.toFixed(2)} lane-km)`, `${top.l.roadId}:widen`)) actions++;
        }
      }
    }

    // 5b. Spillback protection: when a block can't store what the upstream green releases, meter that green.
    for (const n of Object.values(w.nodes)) {
      if (!budget()) break;
      if (n.control.type !== 'signal' || !n.control.signal) continue;
      for (const row of storageReport(w, n.id)) {
        if (!row.risk) continue;
        const link = w.links[row.linkId];
        const up = w.nodes[link.from];
        if (up?.control.type !== 'signal' || !up.control.signal || !this.cool(`${up.id}:meter:${link.id}`)) continue;
        const idx = up.control.signal.phases.findIndex((p) => p.movements.some((k) => up.movements[k]?.toLink === link.id && up.movements[k]?.turn === 'T') && !p.meterLink);
        if (idx < 0) continue;
        if (this.act({ type: 'setMetering', nodeId: up.id, phaseIndex: idx, meterLink: link.id, threshold: 0.75 }, `block ${link.id} stores ${row.storageVehicles} but ${up.id} releases ${row.dischargePerCycle.toFixed(0)}/cycle: meter it`, `${up.id}:meter:${link.id}`)) actions++;
      }
    }
    // 5c. Offset T-junctions that are busy → realign into one crossing (land cost).
    if (budget() && canBuild) {
      for (const off of offsetIntersections(w)) {
        const busy = off.nodes.reduce((s, id) => s + Object.values(w.nodes[id].metrics.demand).reduce((a, d) => a + d, 0), 0);
        if (busy > 500 && w.resources.laneKm >= off.realignCostKm && this.cool(`${off.roadId}:realign`)) {
          if (this.act({ type: 'realignOffset', roadId: off.roadId }, `offset pair ${off.nodes.join('/')} carries ${busy.toFixed(0)} veh/h: realign`, `${off.roadId}:realign`)) actions++;
          break;
        }
      }
    }
    // 6b. Pavement: repave the most worn road before it breeds stalls.
    if (budget() && w.resources.laneKm > 0.1 && canBuild) {
      const worn = Object.values(w.roads)
        .map((r) => ({ r, wear: Math.max(w.links[`${r.id}>`]?.wear ?? 0, w.links[`${r.id}<`]?.wear ?? 0), busy: w.links[`${r.id}>`]?.constructionUntil ?? 0 }))
        .filter((x) => x.wear > 0.6 && x.busy === 0 && this.cool(`${x.r.id}:repave`))
        .sort((a, b) => b.wear - a.wear)[0];
      if (worn && this.act({ type: 'repave', roadId: worn.r.id }, `pavement wear ${(worn.wear * 100).toFixed(0)}% on ${worn.r.id}`, `${worn.r.id}:repave`)) actions++;
    }

    // 7. Tokens: a roundabout at the busiest balanced non-arterial node.
    if (budget() && w.resources.tokens > 0 && canBuild) {
      const cands = Object.values(w.nodes)
        .filter((n) => n.control.type !== 'roundabout' && n.legs.length >= 3 && this.cool(`${n.id}:rab`) && !w.interchanges[n.id])
        .map((n) => ({ n, total: Object.values(n.metrics.demand).reduce((s, d) => s + d, 0), balance: balanceIndex(n) }))
        .filter((x) => x.total > 500 && x.balance > 0.6 && !isArterialNode(w, x.n))
        .sort((a, b) => b.total - a.total);
      if (cands[0] && this.act({ type: 'buildRoundabout', nodeId: cands[0].n.id, lanes: 1 }, `balanced ${cands[0].total.toFixed(0)} veh/h at ${cands[0].n.id}: roundabout`, `${cands[0].n.id}:rab`)) actions++;
    }
  }
}

function worstMovement(n: SimNode): { key: string; vc: number } | null {
  let best: { key: string; vc: number } | null = null;
  for (const k of Object.keys(n.movements)) {
    const d = n.metrics.demand[k] ?? 0;
    const c = n.metrics.capacity[k] ?? 0;
    if (d < 60) continue; // ignore trickles
    const vc = c > 0 ? d / c : 2;
    if (!best || vc > best.vc) best = { key: k, vc };
  }
  return best;
}

function detectorsFor(w: World, n: SimNode): { laneId: string; setback: number }[] {
  const out: { laneId: string; setback: number }[] = [];
  for (const leg of n.legs) {
    if (!leg.inLink) continue;
    const link = w.links[leg.inLink];
    const lanes: Lane[] = [...link.lanes.filter((l) => l.type === 'general'), ...(link.pocketLeft ? [link.pocketLeft] : [])];
    for (const lane of lanes) {
      out.push({ laneId: lane.id, setback: 0 });
      if (link.speedLimit > 11 && lane.type === 'general') out.push({ laneId: lane.id, setback: 80 });
    }
  }
  return out;
}

function splitByPair(w: World, n: SimNode): [LinkId[], LinkId[]] {
  const pair = (a: number, b: number) => n.legs.filter((l) => (l.leg === a || l.leg === b) && l.inLink).map((l) => l.inLink as LinkId);
  const p02 = pair(0, 2);
  const p13 = pair(1, 3);
  const lanes = (ls: LinkId[]) => ls.reduce((s, l) => s + generalLanes(w.links[l]).length, 0);
  return lanes(p02) >= lanes(p13) ? [p02, p13] : [p13, p02];
}

function isArterialNode(w: World, n: SimNode): boolean {
  return n.legs.some((l) => l.inLink && generalLanes(w.links[l.inLink]).length >= 2);
}

/** 1 = perfectly balanced approach demands, 0 = one approach dominates. */
function balanceIndex(n: SimNode): number {
  const byLink = new Map<string, number>();
  for (const [k, d] of Object.entries(n.metrics.demand)) {
    const from = k.split(':')[0];
    byLink.set(from, (byLink.get(from) ?? 0) + d);
  }
  const vals = [...byLink.values()];
  if (vals.length < 3) return 0;
  const max = Math.max(...vals);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  return max > 0 ? mean / max : 0;
}

function affordPocket(w: World, storage: number): boolean {
  return w.resources.laneKm >= laneKmCostForLength(Math.max(0, storage - POCKET_FREE_TAPER));
}

export function summariseBot(bot: EngineerBot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of bot.log) if (a.ok) counts[a.cmd.type] = (counts[a.cmd.type] ?? 0) + 1;
  return counts;
}

export type { NodeId };
