# gand-sim

Headless, deterministic traffic-engineering simulation for **Gand** (see `../GAME_DESIGN.md`). No DOM, no rendering: a renderer reads `World` state and sends `Command`s. Everything in `World` is plain JSON-serialisable data, so `structuredClone` forks it (draft previews) and seed + command log replays it exactly (saves, daily challenges).

```bash
npm install
npm test                      # vitest
npx tsx src/cli/run.ts 1800 42 --signals --debug     # headless run with stall diagnostics
npx tsx src/cli/balance.ts 10 1 --signals --growth=1.12   # multi-day balancing harness
```

## Layout

| Path | What |
|---|---|
| `src/model/types.ts` | The whole data model: nodes, links, lanes, pockets, movements, conflicts, signals, vehicles, generators, buses, resources, incidents, events, metrics. |
| `src/network/` | `geometry.ts` legs, movements and the chord-based conflict matrix (+ ped crossings); `build.ts` world from a `MapDef`; `lanes.ts` lane helpers. |
| `src/control/` | `signal.ts` ring controller (fixed-time, actuated with stop-bar/advance detectors, coordinated offsets, metering, TSP, pre-emption, LPI/exclusive/scramble peds, explicit lost time); `manager.ts` entry permission + gap acceptance for every control type incl. roundabouts, right-on-red, slip lanes (yield/free), sneakers, box protection. |
| `src/traffic/` | `dynamics.ts` IDM car-following, lane choice/changing, pocket overflow, stop lines, node traversal with box blocking, bus stops (curbside/bay), driveway arrivals (right-in / left-in / TWLTL), median crossovers; `pedestrians.ts`; `driveways.ts` throat queues and right-out/left-out; `trips.ts`. |
| `src/demand/` | Land-use production/attraction profiles, O-D choice, mode choice (bus share), trucks, emergency vehicles, bus dispatch. |
| `src/routing/` | Time-dependent Dijkstra over links with control-delay, v/c, stop and unprotected-left penalties; crossover U-turn edges; periodic re-routing; VMS steering. |
| `src/economy/` | Lane-km and structure tokens, weekly allotment + token-or-lanes choice, construction with one-day lane closures. |
| `src/incidents/` | Conflict scoring → crash probability, lane-blocking incidents (crash, severe crash, stall, double-parking, parking manoeuvres, signal malfunction); scheduled events (stadium let-out, school pick-up, roadworks, parade, highway dump, rain, new generators). |
| `src/metrics/` | Rolling people-flow and delay, LOS, HCM-style capacities and v/c, gridlock meter, queue histories; `instruments.ts` read-only queries (TMC, O-D highlight, time-space data, heatmaps, HUD). |
| `src/editor/` | `commands.ts` every player edit as a validated `Command`; `network-edits.ts` lane/road surgery that keeps vehicles and plans consistent; `transforms.ts` roundabout, MUT, RCUT, CFI, interchanges. |
| `src/game/` | `tick.ts` orchestration + day/week transitions; `game.ts` `Game` (time control, draft/preview, save/replay, scenario goals); `scenarios.ts`. |
| `src/maps/tutorial.ts` | 3×3 grid, 200 m blocks, one 2+2 arterial, external gateways, land uses, one bus loop. |

## Using it from a renderer

```ts
import { Game, tutorialMap, instruments } from 'gand-sim';

const game = new Game(tutorialMap(), seed);
game.speed = 2;
game.step(dtRealSeconds);                 // each frame
game.apply({ type: 'setControl', nodeId: 'n11', control: 'signal' });
game.beginDraft(); game.apply(...); const p = game.preview(); game.commitDraft();
instruments.nodeReport(game.world, 'n11'); // TMC, v/c, LOS, lost time
instruments.timeSpaceData(game.world, ['n10', 'n11', 'n12']);
instruments.odForMovement(game.world, 'n11', 'h10>:L');
```

Render from `game.world`: `links[*].lanes[*].vehicles` (ids, sorted front-first), `vehicles[id].place` (`lane` + pos, `node` + movement + pos, `driveway`), `nodes[*].control.runtime` for signal indications via `signalView()`, `incidents`, `metrics`.

## Conventions

- Metres, seconds, radians. Right-hand traffic. Screen coordinates (y down). Legs are slots 0–3 clockwise from north.
- Link ids are `${roadId}>` (a→b) and `${roadId}<` (b→a); lane ids `${linkId}#${index}`, pockets `#pL`/`#pR`, bays `#bay${n}`.
- Movement keys are `${fromLinkId}:${turn}`; ped crossing keys `ped:${leg}`.
- The in-game day is `config.dayLength` sim-seconds (default 3600); physics runs in real seconds, so a 90 s cycle is 90 s.
