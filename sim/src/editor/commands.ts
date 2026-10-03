/**
 * Every player edit is a Command. `applyCommand` validates, charges resources, mutates the world
 * and returns a Result. The ordered command log + seed is the save file.
 */
import type { ControlType, LeftTreatment, LinkId, NodeId, PedTreatment, Phase, Turn, World } from '../model/types.js';
import { autoPlan, emptyPlan, emptyRuntime, normalisePlan, setCycle } from '../control/signal.js';
import { POCKET_FREE_TAPER, TOKEN_COST, applyWeeklyChoice, canAffordLaneKm, hasUnlock, laneKmCostForLength, refundLaneKm, scheduleConstruction, spendLaneKm, spendTokens } from '../economy/resources.js';
import { registerConstructionApplier } from '../economy/construction.js';
import { resetSignalMalfunction } from '../incidents/incidents.js';
import { refreshNodeLegs, roadPosAt } from '../network/build.js';
import { generalLanes } from '../network/lanes.js';
import { destinationLinks, rerouteVehicle } from '../routing/routing.js';
import {
  applyLaneDrops,
  applyWiden,
  fail,
  ok,
  pocketCostMetres,
  reallocate,
  removeLane,
  renormaliseSignals,
  setBusStopKind,
  setLaneType,
  setMedian,
  setOneWay,
  setParking,
  setPocket,
  type PocketSpec,
  type Result,
} from './network-edits.js';
import { buildCfi, buildInterchange, buildMut, buildRcut, buildRoundabout, removeRoundabout, removeTransform } from './transforms.js';

export type Command =
  // lanes
  | { type: 'setLaneTurns'; laneId: string; turns: Turn[] }
  | { type: 'setLaneType'; laneId: string; laneType: 'general' | 'bus' | 'bike'; protectedBus?: boolean }
  | { type: 'reallocate'; roadId: string; fwd: number; bwd: number }
  | { type: 'widen'; roadId: string; dir: 'fwd' | 'bwd' }
  | { type: 'removeLane'; roadId: string; dir: 'fwd' | 'bwd' }
  | { type: 'setPocket'; linkId: LinkId; spec: PocketSpec }
  | { type: 'setParking'; linkId: LinkId; mode: 'none' | 'always' | 'peak-ban' }
  | { type: 'setLoadingZone'; linkId: LinkId; on: boolean }
  | { type: 'setCurbExtensions'; linkId: LinkId; on: boolean }
  | { type: 'setMedian'; roadId: string; median: 'none' | 'open' | 'closed' | 'twltl' }
  | { type: 'setOneWay'; roadId: string; mode: 'none' | 'fwd' | 'bwd' }
  | { type: 'setMergeStyle'; linkId: LinkId; style: 'taper' | 'zipper' }
  | { type: 'setNoLeftIntoDriveways'; linkId: LinkId; on: boolean }
  // node geometry
  | { type: 'setLaneDrop'; nodeId: NodeId; leg: number; mode: 'after' | 'before' }
  | { type: 'setChannelisedRight'; nodeId: NodeId; leg: number; on: boolean }
  | { type: 'setCornerRadius'; nodeId: NodeId; leg: number; radius: 'tight' | 'standard' | 'wide' }
  | { type: 'setBoxProtection'; nodeId: NodeId; on: boolean }
  | { type: 'setPedCrossing'; nodeId: NodeId; leg: number; enabled: boolean }
  // control
  | { type: 'setControl'; nodeId: NodeId; control: Exclude<ControlType, 'roundabout'>; minorLinks?: LinkId[] }
  | { type: 'autoPlan'; nodeId: NodeId }
  | { type: 'setPhases'; nodeId: NodeId; phases: Pick<Phase, 'movements' | 'split'>[] }
  | { type: 'setSplit'; nodeId: NodeId; phaseIndex: number; split: number }
  | { type: 'setCycle'; nodeId: NodeId; cycle: number }
  | { type: 'setLeftTreatment'; nodeId: NodeId; linkId: LinkId; treatment: LeftTreatment }
  | { type: 'setLaggingLeft'; nodeId: NodeId; on: boolean }
  | { type: 'setRightOnRed'; nodeId: NodeId; linkId: LinkId; on: boolean }
  | { type: 'setPedTreatment'; nodeId: NodeId; treatment: PedTreatment }
  | { type: 'setActuated'; nodeId: NodeId; on: boolean }
  | { type: 'setDetectors'; nodeId: NodeId; detectors: { laneId: string; setback: number }[] }
  | { type: 'setCoordination'; nodeId: NodeId; on: boolean; offset: number; coordinatedPhase?: number }
  | { type: 'setMetering'; nodeId: NodeId; phaseIndex: number; meterLink: LinkId | null; threshold?: number }
  | { type: 'setTsp'; nodeId: NodeId; on: boolean; maxExtend?: number }
  | { type: 'resetSignal'; nodeId: NodeId }
  // structures
  | { type: 'buildRoundabout'; nodeId: NodeId; lanes: 1 | 2 }
  | { type: 'removeRoundabout'; nodeId: NodeId }
  | { type: 'transform'; nodeId: NodeId; form: 'mut' | 'rcut' | 'cfi' | 'none' }
  | { type: 'buildInterchange'; nodeId: NodeId; form: 'diamond' | 'spui' | 'ddi' | 'parclo' }
  // access / curb / transit
  | { type: 'setDriveway'; generatorId: string; pos?: number; access?: 'full' | 'right-in-right-out'; throatLength?: number }
  | { type: 'relocateDriveway'; generatorId: string; roadId: string; t: number; side: 'fwd' | 'bwd' }
  | { type: 'consolidateDriveways'; generatorId: string; withGeneratorId: string }
  | { type: 'setMidblockCrossing'; linkId: LinkId; pos: number; signalised: boolean; remove?: boolean }
  | { type: 'setBusStop'; stopId: string; kind: 'curbside' | 'bay'; pos?: number }
  | { type: 'setVms'; nodeId: NodeId; avoidLink: LinkId | null; multiplier?: number }
  // meta
  | { type: 'weeklyChoice'; choice: 'token' | 'lanes' }
  | { type: 'defineCorridor'; id: string; nodeIds: NodeId[] }
  | { type: 'unlock'; keys: string[] };

const UNLOCK_FOR: Partial<Record<Command['type'], string>> = {
  setPocket: 'pocket',
  setCycle: 'cycle',
  setActuated: 'actuation',
  setDetectors: 'actuation',
  setCoordination: 'coordination',
  setMetering: 'metering',
  setTsp: 'tsp',
  buildRoundabout: 'roundabout',
  setOneWay: 'one-way',
  transform: 'innovative',
  buildInterchange: 'interchange',
  setVms: 'vms',
  setLaneType: 'bus-lane',
};

function node(world: World, id: NodeId) {
  const n = world.nodes[id];
  if (!n) throw new Error(`No node ${id}`);
  return n;
}

function ensureSignal(world: World, n: ReturnType<typeof node>): Result {
  if (n.control.type !== 'signal') return fail('Node is not signalised');
  if (!n.control.signal) {
    n.control.signal = autoPlan(n, world);
    n.control.runtime = emptyRuntime(world.t);
  }
  return ok;
}

function touched(world: World, key: string): void {
  world.lastEditAt[key] = world.t;
}

export function applyCommand(world: World, cmd: Command): Result {
  const need = UNLOCK_FOR[cmd.type];
  if (need && !hasUnlock(world, need) && world.resources.unlocks.length) return fail(`Locked: ${need}`);
  try {
    return dispatch(world, cmd);
  } catch (e) {
    return fail((e as Error).message);
  }
}

function dispatch(world: World, cmd: Command): Result {
  switch (cmd.type) {
    // ── lanes ──
    case 'setLaneTurns': {
      const lane = world.lanes[cmd.laneId];
      if (!lane) return fail('No such lane');
      if (lane.type === 'parking' || lane.type === 'bay') return fail('Not a travel lane');
      if (!cmd.turns.length) return fail('A lane must allow at least one turn');
      lane.allowed = [...new Set(cmd.turns)];
      const link = world.links[lane.linkId];
      refreshNodeLegs(world, world.nodes[link.to]);
      renormaliseSignals(world, [link.to]);
      touched(world, link.to);
      return ok;
    }
    case 'setLaneType': {
      const lane = world.lanes[cmd.laneId];
      if (!lane) return fail('No such lane');
      return setLaneType(world, lane, cmd.laneType, cmd.protectedBus);
    }
    case 'reallocate': {
      const road = world.roads[cmd.roadId];
      if (!road) return fail('No such road');
      const r = reallocate(world, road, cmd.fwd, cmd.bwd);
      if (r.ok) touched(world, road.a), touched(world, road.b);
      return r;
    }
    case 'widen': {
      const road = world.roads[cmd.roadId];
      if (!road) return fail('No such road');
      const link = world.links[cmd.dir === 'fwd' ? `${road.id}>` : `${road.id}<`];
      if (!link) return fail('No such direction');
      if (link.constructionUntil > world.t) return fail('Already under construction');
      const km = laneKmCostForLength(road.length);
      if (!canAffordLaneKm(world, km)) return fail(`Needs ${km.toFixed(2)} lane-km`);
      spendLaneKm(world, km);
      const general = generalLanes(link);
      scheduleConstruction(world, { kind: 'widen', linkId: link.id, nodeId: null, laneId: general.length > 1 ? general[general.length - 1].id : null, payload: { roadId: road.id, dir: cmd.dir } });
      if (general.length <= 1) link.speedLimit = link.designSpeed * 0.6;
      return ok;
    }
    case 'removeLane': {
      const road = world.roads[cmd.roadId];
      if (!road) return fail('No such road');
      const r = removeLane(world, road, cmd.dir);
      if (r.ok) refundLaneKm(world, laneKmCostForLength(road.length));
      return r;
    }
    case 'setPocket': {
      const link = world.links[cmd.linkId];
      if (!link) return fail('No such link');
      const existing = cmd.spec.side === 'left' ? link.pocketLeft : link.pocketRight;
      const oldCost = existing ? laneKmCostForLength(pocketCostMetres(existing.end - existing.start, POCKET_FREE_TAPER)) : 0;
      const newCost = laneKmCostForLength(pocketCostMetres(cmd.spec.storage, POCKET_FREE_TAPER));
      if (newCost > oldCost && !canAffordLaneKm(world, newCost - oldCost)) return fail(`Needs ${(newCost - oldCost).toFixed(2)} lane-km`);
      const r = setPocket(world, link, cmd.spec);
      if (!r.ok) return r;
      if (newCost > oldCost) spendLaneKm(world, newCost - oldCost);
      else refundLaneKm(world, oldCost - newCost);
      touched(world, link.to);
      return ok;
    }
    case 'setParking': {
      const link = world.links[cmd.linkId];
      if (!link) return fail('No such link');
      return setParking(world, link, cmd.mode);
    }
    case 'setLoadingZone': {
      const link = world.links[cmd.linkId];
      if (!link) return fail('No such link');
      link.loadingZone = cmd.on;
      return ok;
    }
    case 'setCurbExtensions': {
      const link = world.links[cmd.linkId];
      if (!link) return fail('No such link');
      link.curbExtensions = cmd.on;
      // Shorter crossings at the downstream node.
      const n = world.nodes[link.to];
      refreshNodeLegs(world, n);
      for (const p of Object.values(n.peds)) if (cmd.on) p.width = Math.max(6, p.width - 4);
      renormaliseSignals(world, [n.id]);
      return ok;
    }
    case 'setMedian': {
      const road = world.roads[cmd.roadId];
      if (!road) return fail('No such road');
      return setMedian(world, road, cmd.median);
    }
    case 'setOneWay': {
      const road = world.roads[cmd.roadId];
      if (!road) return fail('No such road');
      if (cmd.mode !== 'none' && road.oneWay === 'none') {
        if (world.resources.tokens < TOKEN_COST.oneWay) return fail('Needs a structure token');
        const r = setOneWay(world, road, cmd.mode);
        if (r.ok) spendTokens(world, TOKEN_COST.oneWay);
        return r;
      }
      return setOneWay(world, road, cmd.mode);
    }
    case 'setMergeStyle': {
      const link = world.links[cmd.linkId];
      if (!link) return fail('No such link');
      link.mergeStyle = cmd.style;
      return ok;
    }
    case 'setNoLeftIntoDriveways': {
      const link = world.links[cmd.linkId];
      if (!link) return fail('No such link');
      link.noLeftIntoDriveways = cmd.on;
      for (const v of Object.values(world.vehicles)) if (v.destGen && !v.cyclic && v.route.includes(link.id)) rerouteVehicle(world, v);
      return ok;
    }
    // ── node geometry ──
    case 'setLaneDrop': {
      const n = node(world, cmd.nodeId);
      const leg = n.legs.find((l) => l.leg === cmd.leg);
      if (!leg) return fail('No such leg');
      leg.laneDrop = cmd.mode;
      applyLaneDrops(world, n.id);
      return ok;
    }
    case 'setChannelisedRight': {
      const n = node(world, cmd.nodeId);
      const leg = n.legs.find((l) => l.leg === cmd.leg);
      if (!leg) return fail('No such leg');
      leg.channelisedRight = cmd.on;
      return ok;
    }
    case 'setCornerRadius': {
      const n = node(world, cmd.nodeId);
      const leg = n.legs.find((l) => l.leg === cmd.leg);
      if (!leg) return fail('No such leg');
      leg.cornerRadius = cmd.radius;
      // Wide corners lengthen the ped crossing; tight ones shorten it.
      const p = n.peds[`ped:${leg.leg}`];
      if (p) p.width = Math.max(6, p.width + (cmd.radius === 'wide' ? 3 : cmd.radius === 'tight' ? -2 : 0));
      renormaliseSignals(world, [n.id]);
      return ok;
    }
    case 'setBoxProtection': {
      node(world, cmd.nodeId).boxProtection = cmd.on;
      return ok;
    }
    case 'setPedCrossing': {
      const n = node(world, cmd.nodeId);
      const p = n.peds[`ped:${cmd.leg}`];
      if (!p) return fail('No crossing on that leg');
      p.enabled = cmd.enabled;
      renormaliseSignals(world, [n.id]);
      return ok;
    }
    // ── control ──
    case 'setControl': {
      const n = node(world, cmd.nodeId);
      if (n.control.type === 'roundabout') return fail('Remove the roundabout first');
      if (cmd.control === 'signal' && !hasUnlock(world, 'signal') && world.resources.unlocks.length) return fail('Locked: signal');
      const minor = cmd.minorLinks ?? [];
      if ((cmd.control === 'two-way-stop' || cmd.control === 'yield') && !minor.length) {
        // Default minor = the pair with fewer lanes.
        const legsByPair = [n.legs.filter((l) => l.leg % 2 === 0), n.legs.filter((l) => l.leg % 2 === 1)];
        const lanes = (ls: typeof n.legs) => ls.reduce((s, l) => s + (l.inLink ? generalLanes(world.links[l.inLink]).length : 0), 0);
        const minorLegs = lanes(legsByPair[0]) <= lanes(legsByPair[1]) ? legsByPair[0] : legsByPair[1];
        minor.push(...minorLegs.flatMap((l) => (l.inLink ? [l.inLink] : [])));
      }
      const keepPlan = n.control.signal;
      n.control = { type: cmd.control, minorLinks: minor, signal: cmd.control === 'signal' ? keepPlan ?? autoPlan(n, world) : keepPlan, runtime: cmd.control === 'signal' ? emptyRuntime(world.t) : null, roundaboutLanes: 1 };
      if (cmd.control === 'signal' && n.control.signal) normalisePlan(n, world, n.control.signal);
      touched(world, n.id);
      return ok;
    }
    case 'autoPlan': {
      const n = node(world, cmd.nodeId);
      if (n.control.type !== 'signal') return fail('Not signalised');
      n.control.signal = autoPlan(n, world, n.control.signal ?? undefined);
      n.control.runtime = emptyRuntime(world.t);
      return ok;
    }
    case 'setPhases': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      if (!cmd.phases.length) return fail('Need at least one phase');
      const plan = n.control.signal!;
      // Validate: no hard conflicts inside a phase.
      for (const ph of cmd.phases) {
        for (const a of ph.movements) {
          if (!n.movements[a]) return fail(`Unknown movement ${a}`);
          for (const b of ph.movements) if (a !== b && n.conflicts[a]?.[b] === 'cross') {
            // Permitted lefts may share a phase with the opposing through; everything else may not.
            const ma = n.movements[a];
            const mb = n.movements[b];
            const permittedPair = (ma.turn === 'L' || ma.turn === 'U' || mb.turn === 'L' || mb.turn === 'U') && ma.entryLeg === ((mb.entryLeg + 2) % 4);
            if (!permittedPair) return fail(`${a} and ${b} conflict and cannot share a phase`);
          }
        }
      }
      const base = emptyPlan();
      plan.phases = cmd.phases.map((ph, i) => ({ ...base.phases[0], id: i + 1, movements: [...ph.movements], peds: [], split: Math.max(5, ph.split), minGreen: 7, maxGreen: Math.max(5, ph.split) * 1.5, coordinated: false, meterLink: null, meterThreshold: 0.8, lpi: 0 }));
      normalisePlan(n, world, plan);
      n.control.runtime = emptyRuntime(world.t);
      touched(world, n.id);
      return ok;
    }
    case 'setSplit': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      const ph = n.control.signal!.phases[cmd.phaseIndex];
      if (!ph) return fail('No such phase');
      ph.split = Math.max(ph.minGreen, cmd.split);
      ph.maxGreen = Math.max(ph.maxGreen, ph.split);
      normalisePlan(n, world, n.control.signal!);
      return ok;
    }
    case 'setCycle': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      if (cmd.cycle < 40 || cmd.cycle > 180) return fail('Cycle must be 40–180 s');
      setCycle(n, world, n.control.signal!, cmd.cycle);
      return ok;
    }
    case 'setLeftTreatment': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      n.control.signal!.leftTreatment[cmd.linkId] = cmd.treatment;
      n.control.signal = autoPlan(n, world, n.control.signal!);
      n.control.runtime = emptyRuntime(world.t);
      return ok;
    }
    case 'setLaggingLeft': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      n.control.signal!.laggingLeft = cmd.on;
      n.control.signal = autoPlan(n, world, n.control.signal!);
      n.control.runtime = emptyRuntime(world.t);
      return ok;
    }
    case 'setRightOnRed': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      n.control.signal!.rightOnRed[cmd.linkId] = cmd.on;
      return ok;
    }
    case 'setPedTreatment': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      n.control.signal!.pedTreatment = cmd.treatment;
      normalisePlan(n, world, n.control.signal!);
      return ok;
    }
    case 'setActuated': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      n.control.signal!.actuated = cmd.on;
      normalisePlan(n, world, n.control.signal!);
      return ok;
    }
    case 'setDetectors': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      for (const d of cmd.detectors) if (!world.lanes[d.laneId]) return fail(`No lane ${d.laneId}`);
      n.control.signal!.detectors = cmd.detectors.map((d) => ({ laneId: d.laneId, setback: Math.max(0, Math.min(150, d.setback)) }));
      return ok;
    }
    case 'setCoordination': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      const plan = n.control.signal!;
      plan.coordinated = cmd.on;
      plan.offset = cmd.offset;
      plan.phases.forEach((p, i) => (p.coordinated = cmd.on && i === (cmd.coordinatedPhase ?? plan.phases.findIndex((x) => x.movements.some((k) => k.endsWith(':T'))))));
      if (cmd.on && !plan.phases.some((p) => p.coordinated) && plan.phases.length) plan.phases[0].coordinated = true;
      return ok;
    }
    case 'setMetering': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      const ph = n.control.signal!.phases[cmd.phaseIndex];
      if (!ph) return fail('No such phase');
      if (cmd.meterLink && !world.links[cmd.meterLink]) return fail('No such link');
      ph.meterLink = cmd.meterLink;
      ph.meterThreshold = cmd.threshold ?? 0.8;
      return ok;
    }
    case 'setTsp': {
      const n = node(world, cmd.nodeId);
      const r = ensureSignal(world, n);
      if (!r.ok) return r;
      n.control.signal!.tsp = cmd.on;
      if (cmd.maxExtend !== undefined) n.control.signal!.tspMaxExtend = cmd.maxExtend;
      return ok;
    }
    case 'resetSignal':
      return resetSignalMalfunction(world, cmd.nodeId) ? ok : fail('Signal is not malfunctioning');
    // ── structures ──
    case 'buildRoundabout': {
      const n = node(world, cmd.nodeId);
      if (world.resources.tokens < TOKEN_COST.roundabout) return fail('Needs a structure token');
      const r = buildRoundabout(world, n, cmd.lanes);
      if (r.ok) {
        spendTokens(world, TOKEN_COST.roundabout);
        scheduleConstruction(world, { kind: 'roundabout', linkId: null, nodeId: n.id, laneId: null, payload: null });
      }
      return r;
    }
    case 'removeRoundabout': {
      const r = removeRoundabout(world, node(world, cmd.nodeId));
      if (r.ok) world.resources.tokens += TOKEN_COST.roundabout;
      return r;
    }
    case 'transform': {
      const n = node(world, cmd.nodeId);
      if (cmd.form === 'none') {
        const prev = n.form;
        const r = removeTransform(world, n.id);
        if (r.ok) world.resources.tokens += prev.startsWith('cfi') ? TOKEN_COST.cfi : prev.startsWith('mut') || prev.startsWith('rcut') ? TOKEN_COST.mut : 0;
        return r;
      }
      const cost = cmd.form === 'cfi' ? TOKEN_COST.cfi : TOKEN_COST.mut;
      if (world.resources.tokens < cost) return fail(`Needs ${cost} structure token(s)`);
      const r = cmd.form === 'mut' ? buildMut(world, n) : cmd.form === 'rcut' ? buildRcut(world, n) : buildCfi(world, n);
      if (r.ok) {
        spendTokens(world, cost);
        scheduleConstruction(world, { kind: 'transform', linkId: null, nodeId: n.id, laneId: null, payload: null });
        touched(world, n.id);
      }
      return r;
    }
    case 'buildInterchange': {
      const n = node(world, cmd.nodeId);
      if ((world.structureCounts['interchange'] ?? 0) >= 2) return fail('Interchange limit reached (2)');
      if (world.resources.tokens < TOKEN_COST.interchange) return fail(`Needs ${TOKEN_COST.interchange} structure tokens`);
      const r = buildInterchange(world, n, cmd.form);
      if (r.ok) {
        spendTokens(world, TOKEN_COST.interchange);
        scheduleConstruction(world, { kind: 'interchange', linkId: null, nodeId: n.id, laneId: null, payload: null });
      }
      return r;
    }
    // ── access ──
    case 'setDriveway': {
      const gen = world.generators[cmd.generatorId];
      if (!gen) return fail('No such generator');
      const link = world.links[gen.drivewayLink];
      const dw = link.driveways.find((d) => d.generatorId === gen.id);
      if (!dw) return fail('No driveway');
      if (cmd.pos !== undefined) {
        if (cmd.pos < 10 || cmd.pos > link.length - 10) return fail('Driveway must be 10 m from either end');
        dw.pos = cmd.pos;
      }
      if (cmd.access) dw.access = cmd.access;
      if (cmd.throatLength !== undefined) dw.throatLength = Math.max(6, cmd.throatLength);
      for (const v of Object.values(world.vehicles)) if (v.destGen === gen.id || v.originGen === gen.id) rerouteVehicle(world, v);
      return ok;
    }
    case 'relocateDriveway': {
      const gen = world.generators[cmd.generatorId];
      const road = world.roads[cmd.roadId];
      if (!gen || !road) return fail('No such generator/road');
      const target = world.links[cmd.side === 'fwd' ? `${road.id}>` : `${road.id}<`];
      if (!target) return fail('No such direction');
      const km = 0.05; // short connector
      if (!canAffordLaneKm(world, km)) return fail('Needs 0.05 lane-km for the connector');
      const old = world.links[gen.drivewayLink];
      const dw = old.driveways.find((d) => d.generatorId === gen.id);
      if (!dw) return fail('No driveway');
      spendLaneKm(world, km);
      old.driveways.splice(old.driveways.indexOf(dw), 1);
      const at = roadPosAt(road, cmd.t);
      dw.linkId = target.id;
      dw.pos = target.id.endsWith('>') ? at.fwdPos : at.bwdPos;
      target.driveways.push(dw);
      gen.drivewayLink = target.id;
      gen.roadId = road.id;
      for (const v of Object.values(world.vehicles)) if (v.destGen === gen.id) rerouteVehicle(world, v);
      return ok;
    }
    case 'consolidateDriveways': {
      const a = world.generators[cmd.generatorId];
      const b = world.generators[cmd.withGeneratorId];
      if (!a || !b) return fail('No such generator');
      if (a.drivewayLink !== b.drivewayLink) return fail('Generators must front the same link');
      const link = world.links[a.drivewayLink];
      const da = link.driveways.find((d) => d.generatorId === a.id);
      const db = link.driveways.find((d) => d.generatorId === b.id);
      if (!da || !db) return fail('No driveway');
      // Move b's trips through a's driveway: b's driveway becomes a's position; keep separate queues.
      db.pos = da.pos;
      da.sharedWith.push(b.id);
      db.sharedWith.push(a.id);
      da.throatLength = db.throatLength = Math.max(da.throatLength, db.throatLength) + 10;
      return ok;
    }
    case 'setMidblockCrossing': {
      const link = world.links[cmd.linkId];
      if (!link) return fail('No such link');
      const road = world.roads[link.roadId];
      const fwd = world.links[`${road.id}>`] ?? link;
      const pos = link.id.endsWith('>') ? cmd.pos : road.length - cmd.pos;
      fwd.crossings = fwd.crossings.filter((c) => Math.abs(c.pos - pos) > 15);
      if (!cmd.remove) {
        if (pos < 20 || pos > road.length - 20) return fail('Too close to an intersection');
        fwd.crossings.push({ id: `${road.id}@${Math.round(pos)}`, linkId: fwd.id, pos, signalised: cmd.signalised, waiting: 0, activeUntil: 0, demandPerHour: 30 });
      }
      return ok;
    }
    case 'setBusStop': {
      const stop = world.busStops[cmd.stopId];
      if (!stop) return fail('No such stop');
      if (cmd.pos !== undefined) {
        const link = world.links[stop.linkId];
        stop.pos = Math.max(15, Math.min(link.length - 15, cmd.pos));
        stop.nearSide = stop.pos > link.length * 0.7;
      }
      return setBusStopKind(world, cmd.stopId, cmd.kind);
    }
    case 'setVms': {
      const n = node(world, cmd.nodeId);
      if (!cmd.avoidLink) {
        n.vms = null;
        return ok;
      }
      if (!world.links[cmd.avoidLink]) return fail('No such link');
      n.vms = { nodeId: n.id, avoidLink: cmd.avoidLink, multiplier: cmd.multiplier ?? 2.5, compliance: 0.5 };
      return ok;
    }
    // ── meta ──
    case 'weeklyChoice':
      return applyWeeklyChoice(world, cmd.choice) ? ok : fail('No weekly choice pending');
    case 'defineCorridor':
      for (const id of cmd.nodeIds) if (!world.nodes[id]) return fail(`No node ${id}`);
      world.corridors[cmd.id] = [...cmd.nodeIds];
      return ok;
    case 'unlock':
      for (const k of cmd.keys) if (!world.resources.unlocks.includes(k)) world.resources.unlocks.push(k);
      return ok;
  }
}

// Construction completion effects.
registerConstructionApplier((world, c) => {
  if (c.kind === 'widen') {
    const { roadId, dir } = c.payload as { roadId: string; dir: 'fwd' | 'bwd' };
    const road = world.roads[roadId];
    if (road) applyWiden(world, road, dir);
    const link = world.links[dir === 'fwd' ? `${roadId}>` : `${roadId}<`];
    if (link) link.speedLimit = link.designSpeed;
  }
});

export { destinationLinks };
