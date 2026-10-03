/**
 * Game: owns the world, the command log, time control, draft/preview and scenario goals.
 * Save = seed + map + ordered commands with timestamps; deterministic replay rebuilds any state.
 */
import type { World, WorldConfig } from '../model/types.js';
import type { MapDef } from '../network/mapdef.js';
import { buildWorld } from '../network/build.js';
import { applyCommand, type Command } from '../editor/commands.js';
import type { Result } from '../editor/network-edits.js';
import { tick } from './tick.js';
import { hudSummary } from '../metrics/instruments.js';
import { pendingAnnouncements } from '../incidents/events.js';
import { averageDelay, currentFlowPerHour } from '../metrics/metrics.js';
import type { Scenario } from './scenarios.js';

export interface LoggedCommand {
  t: number;
  cmd: Command;
}

export interface SaveFile {
  version: 1;
  seed: number;
  scenarioId: string | null;
  map: MapDef;
  config: Partial<WorldConfig>;
  commands: LoggedCommand[];
  startTime: number;
}

export interface PreviewResult {
  seconds: number;
  before: { flow: number; delay: number; gridlock: number; vehicles: number };
  after: { flow: number; delay: number; gridlock: number; vehicles: number };
  /** Per-node average control delay deltas (after − before). */
  nodeDelayDelta: Record<string, number>;
  errors: string[];
}

export type Speed = 0 | 1 | 2 | 4;

export class Game {
  world: World;
  readonly seed: number;
  readonly map: MapDef;
  readonly scenario: Scenario | null;
  readonly log: LoggedCommand[] = [];
  speed: Speed = 1;
  private accumulator = 0;
  /** Draft mode: commands staged but not applied. */
  draft: Command[] | null = null;
  private readonly configOverrides: Partial<WorldConfig>;
  private readonly startTime: number;

  constructor(map: MapDef, seed = 1, scenario: Scenario | null = null, configOverrides: Partial<WorldConfig> = {}, startTime?: number) {
    this.map = map;
    this.seed = seed;
    this.scenario = scenario;
    this.configOverrides = { ...(scenario?.config ?? {}), ...configOverrides };
    this.world = buildWorld(map, seed, this.configOverrides);
    this.startTime = startTime ?? (scenario?.startTimeOfDay ?? 0.25) * this.world.config.dayLength;
    this.world.t = this.startTime;
    if (scenario) applyCommand(this.world, { type: 'unlock', keys: scenario.unlocks });
  }

  static fromScenario(s: Scenario, seed = 1): Game {
    return new Game(s.map(), seed, s);
  }

  /** Advance by `realSeconds` of wall-clock at the current speed. Editing while paused is allowed. */
  step(realSeconds: number): void {
    if (this.speed === 0 || this.world.gameOver) return;
    this.accumulator += realSeconds * this.speed;
    const dt = this.world.config.tickDt;
    let guard = 0;
    while (this.accumulator >= dt && guard++ < 10000) {
      tick(this.world);
      this.accumulator -= dt;
      if (this.world.gameOver) break;
    }
  }

  /** Advance exactly `simSeconds` regardless of speed (tests, previews, headless runs). */
  advance(simSeconds: number): void {
    const n = Math.round(simSeconds / this.world.config.tickDt);
    for (let i = 0; i < n && !this.world.gameOver; i++) tick(this.world);
  }

  /** Apply a command now (or stage it when in draft mode). */
  apply(cmd: Command): Result {
    if (this.draft) {
      // Validate against a throwaway copy so the player gets immediate feedback.
      const probe = structuredClone(this.world);
      for (const c of this.draft) applyCommand(probe, c);
      const r = applyCommand(probe, cmd);
      if (r.ok) this.draft.push(cmd);
      return r;
    }
    const r = applyCommand(this.world, cmd);
    if (r.ok) this.log.push({ t: this.world.t, cmd });
    return r;
  }

  beginDraft(): void {
    this.draft ??= [];
  }

  discardDraft(): void {
    this.draft = null;
  }

  /** Commit staged commands to the live world. */
  commitDraft(): Result[] {
    const cmds = this.draft ?? [];
    this.draft = null;
    return cmds.map((c) => this.apply(c));
  }

  /** Simulate the draft (or any command list) on a fork for `seconds` and compare with doing nothing. */
  preview(commands: Command[] = this.draft ?? [], seconds = this.world.config.previewSeconds): PreviewResult {
    const base = structuredClone(this.world);
    const fork = structuredClone(this.world);
    const errors: string[] = [];
    for (const c of commands) {
      const r = applyCommand(fork, c);
      if (!r.ok) errors.push(r.error);
    }
    const n = Math.round(seconds / this.world.config.tickDt);
    for (let i = 0; i < n; i++) {
      tick(base);
      tick(fork);
    }
    const snap = (w: World) => ({ flow: currentFlowPerHour(w), delay: averageDelay(w), gridlock: w.metrics.gridlock, vehicles: Object.keys(w.vehicles).length });
    const nodeDelayDelta: Record<string, number> = {};
    for (const id of Object.keys(base.nodes)) {
      const b = base.nodes[id].metrics;
      const f = fork.nodes[id].metrics;
      const bd = b.served ? b.delayAccum / b.served : 0;
      const fd = f.served ? f.delayAccum / f.served : 0;
      nodeDelayDelta[id] = fd - bd;
    }
    return { seconds, before: snap(base), after: snap(fork), nodeDelayDelta, errors };
  }

  hud() {
    return hudSummary(this.world);
  }

  /** Scenario progress, if any. */
  goal() {
    if (!this.scenario) return null;
    const g = this.scenario.goal(this.world);
    const failed = this.world.day >= this.scenario.deadlineDay && !g.met;
    return { ...g, failed, deadlineDay: this.scenario.deadlineDay, brief: this.scenario.brief };
  }

  announcements() {
    return pendingAnnouncements(this.world);
  }

  save(): SaveFile {
    return { version: 1, seed: this.seed, scenarioId: this.scenario?.id ?? null, map: this.map, config: this.configOverrides, commands: [...this.log], startTime: this.startTime };
  }

  /** Rebuild a game by replaying its command log up to `untilT` (defaults to the last command). */
  static load(save: SaveFile, scenario: Scenario | null, untilT?: number): Game {
    const g = new Game(save.map, save.seed, scenario, save.config, save.startTime);
    const end = untilT ?? (save.commands.length ? save.commands[save.commands.length - 1].t : g.world.t);
    for (const lc of save.commands) {
      if (lc.t > end) break;
      if (lc.t > g.world.t) g.advance(lc.t - g.world.t);
      g.apply(lc.cmd);
    }
    if (end > g.world.t) g.advance(end - g.world.t);
    return g;
  }
}
