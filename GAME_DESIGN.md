# Gand — Game Design Document

> Working title. A minimalist traffic-engineering game in the spirit of *Mini Motorways*, except you never draw the road network. The city is already built. You are the traffic engineer: you design intersections, assign lanes, time signals, and keep everything flowing as demand grows.

---

## 1. Pitch

**One sentence:** *Mini Motorways*, but the roads are fixed and the only thing you control is how traffic moves through them.

**Fantasy:** You are the person nobody thanks when the morning commute is smooth and everybody blames when it isn't.

**Core loop (30–90 seconds):**
1. Watch traffic. Spot a queue forming.
2. Diagnose *why* (bad signal phase, missing turn lane, cross-traffic conflict, downstream blockage).
3. Open the intersection or road segment and redesign it.
4. Watch the queue drain — or discover you pushed the jam one block downstream.

**Win/lose:** Survive as long as possible. The city grows, demand rises, and the game ends when any single intersection stays gridlocked for too long.

---

## 2. What Makes It Different From Mini Motorways

| Mini Motorways | Gand |
|---|---|
| You draw roads between houses and destinations | Roads already exist; you can't add or remove them |
| Upgrades are coarse (roundabout, traffic light, motorway) | Intersections are fully designable: lanes, turn permissions, signal phases, timing |
| Traffic is abstracted; cars pathfind simply | Traffic is lane-aware: cars queue in the lane that matches their turn, merge, block boxes, run yellows |
| Failure = a destination's queue overflows | Failure = an intersection gridlocks (spillback + cross-blocking) |
| Pressure comes from new houses spawning | Pressure comes from demand growth, events, and newly opened trip generators you can't refuse |

The ownership is clear: **topology is given, flow is yours.**

---

## 3. Core Systems

### 3.1 The Map

- A grid-ish city on a fixed canvas. Roads are pre-laid: a mix of 1-lane-per-direction locals, 2-lane collectors, and a 3-lane arterial or two.
- **Trip generators** (houses, offices, shops, a stadium, a school) spawn trips between each other on a schedule. Demand grows over time and new generators activate as the city "grows" — but roads never change.
- **Intersections** are the editable unit. Every point where two or more roads meet is one. Most start as plain uncontrolled 4-ways or T-junctions with one lane each way and all turns permitted.
- **Road segments** between intersections are also editable (lane allocation only — you can't widen the pavement, but you can decide what the lanes do).

### 3.2 Cars

Each car:
- Has an origin, destination, and a precomputed route (recomputed when you change turn permissions).
- Chooses a lane on approach based on its upcoming turn. If the correct lane is full, it queues behind it in the adjacent lane and blocks that lane too (this is the primary way jams propagate).
- Obeys signals, stop signs, and yield rules. Follows gap-acceptance for unprotected turns (left across oncoming, right-on-red if enabled).
- **Won't enter an intersection it can't clear** — unless the player has disabled "box protection" at that node. Box blocking is the thing that turns a slow intersection into a gridlocked one.
- Has a patience meter. Low patience → more aggressive gap acceptance, runs yellows. Visually: cars flicker/turn red before they count toward the failure meter.

### 3.3 Intersection Editor (the game)

Click an intersection to open the editor. It's a top-down close-up of just that node with its four (or three) approaches.

**Per approach, per lane:**
- Turn permission: Left / Through / Right / any combination (e.g. a shared Through+Right lane).
- Lane count on the approach is fixed by the road's width, but within a short "approach taper" you may **reallocate** — a 2-lane road can become 3 narrow lanes at the stop line (a dedicated turn pocket), at the cost of lane capacity (narrow lanes → lower saturation flow).

**Control type (per intersection):**
| Type | Behaviour | Unlock |
|---|---|---|
| Uncontrolled | First-come, right-hand priority. Fine at low volume, chaos above. | Start |
| Two-way stop / Yield | Minor road stops, major flows freely. | Start |
| All-way stop | Everyone stops. Fair, slow, capped throughput. | Start |
| Signal | Phases, timings, protected/permitted turns. The main tool. | Early |
| Roundabout | Replaces the node. Great for balanced flows, terrible when one approach dominates. Takes a one-way footprint cost. | Mid |
| Grade separation (overpass) | Removes one conflict entirely. Very expensive, limited count. | Late / rare |

**Signal design UI:**
- A **phase ring**: add phases, drag to reorder, assign movements (arrows) to each phase. The game greys out conflicting movements so you can't make an illegal phase.
- Per phase: green time (slider), yellow and all-red are auto-computed from approach speed.
- Toggle per movement: **Protected** (own arrow), **Permitted** (yield on green ball), **Protected+Permitted**.
- Toggle per approach: **Right on red**.
- Toggle per intersection: **Actuated mode** (phases skip if no demand, extend up to a max if queue remains) — unlocks mid-game.
- **Coordination:** when two signals are on the same corridor, a cable icon lets you link them and set an offset. Getting a green wave on the arterial is the single most satisfying thing in the game.

**Live feedback inside the editor:**
- The simulation keeps running (at half speed) while you edit, so you see the effect immediately.
- A per-movement bar shows **demand vs. capacity** for the current design. Red bars are the ones that will queue.
- A ghost queue preview shows how far back each lane's queue will reach at saturation.

### 3.4 Road Segment Editor

Click a road segment between two intersections:
- Reallocate lanes: e.g. convert a 2+2 road into a 3+1 (tidal flow) or a 1+1 with a center turn lane.
- **One-way** conversion: both lanes go one direction. Cars reroute. Huge capacity gain on that corridor, huge headache for anything that used to go the other way.
- Add **turn restrictions** mid-block (no left into that driveway).
- Set **speed** (affects yellow timing, saturation flow, and how fast spillback happens).

### 3.5 Metrics That Matter

Shown on a slim HUD:
- **Flow** — cars completing trips per minute (the score).
- **Average delay** — seconds per car. Yellow above a threshold, red above another.
- **Gridlock meter** — fills while any intersection is box-blocked. Empties when cleared. Full = game over.
- Per-intersection **Level of Service** (A–F) badge when zoomed out, so you can scan for the Fs.

### 3.6 Pressure Curve

Difficulty comes from demand, not from new topology:
- **Steady growth:** trips/min increases every in-game day.
- **Peaks:** AM and PM rush create directional surges (tidal flow matters).
- **Events:** the stadium empties all at once; a school zone drops speed at 3pm; a road segment closes for a week of "roadworks" and you must reroute around it with turn restrictions and one-ways.
- **New generators:** a mall opens on an already-strained corridor. You can't say no.

### 3.7 Economy (light)

Keep it minimal — the puzzle is the fun, not the budget.
- You earn **points** continuously from completed trips.
- Signals and lane changes are **free and instant** (iteration is the game).
- Roundabouts, overpasses, and one-way conversions cost points and take in-game time to "build" (traffic worsens during construction — a deliberate risk/reward).
- Optional **daily challenge** mode: fixed seed, fixed map, 10 in-game days, leaderboard on total flow.

---

## 4. Progression & Unlocks

Each city is a run. Unlocks persist across runs:

1. **Tutorial city** — 4 intersections, teaches lanes and stop/signal basics.
2. **First real city** — unlocks protected lefts and right-on-red.
3. Survive 10 days → **Actuated signals**.
4. Survive 15 days → **Signal coordination / offsets**.
5. Survive 20 days → **Roundabouts**.
6. Survive 30 days → **Overpass** (limit 2 per city).
7. Milestone-based **new cities** with different topologies: grid, radial, river with 3 bridges, highway-with-exits, old-town irregular.

---

## 5. Art, Feel, Audio

- **Visual:** flat, minimalist, high contrast. Roads are mid-grey ribbons; lane markings are crisp white; cars are small saturated rectangles colored by destination type. Signals are visible as tiny colored dots at stop lines when zoomed in, and as a phase indicator ring when zoomed out.
- **Readability over realism.** Queue length should be legible at a glance. Box-blocked intersections pulse.
- **Camera:** smooth zoom from whole-city to single-intersection. Editor is a modal zoom, not a separate screen.
- **Audio:** ambient lo-fi; subtle ticks as signal phases change; a soft chord when a queue drains; a low rumble building as the gridlock meter fills. No horns (too stressful; the metric is stressful enough).
- **Time control:** pause, 1x, 2x, 4x. Editing is always allowed, including while paused.

---

## 6. Technical Notes

### 6.1 Simulation model
- **Discrete lanes, continuous position.** Each lane is a 1D track; cars are points with length and velocity along it. Car-following via a simple IDM (Intelligent Driver Model) or Krauss model — cheap and gives realistic shockwaves.
- **Intersections as conflict matrices.** Each movement (approach × turn) has a set of conflicting movements. Signals grant right-of-way to sets of non-conflicting movements. Uncontrolled nodes resolve via priority rules + gap acceptance.
- **Lane choice** is decided one segment ahead using the route's next turn; lane changes are allowed only in the taper zone and only if a gap exists — otherwise the car waits and blocks.
- **Routing:** time-dependent Dijkstra on the segment graph using recent observed travel times. Re-route a fraction of cars every N seconds so the network self-balances (and so a one-way conversion actually diverts traffic).
- **Spillback:** a lane's entry is closed when its storage is full; this is what propagates queues upstream and causes box-blocking.

### 6.2 Tick budget
- Target 500–2000 cars at 60 fps in a browser. Fixed 10 Hz physics step, interpolated rendering. Spatial sort per lane makes car-following O(n).

### 6.3 Stack (suggested)
- TypeScript + HTML canvas (or PixiJS) for rendering. Sim is pure TS with no DOM dependency so it can be unit-tested and run headless for balancing.
- Deterministic seeded RNG for daily challenges and replays.
- Save = seed + ordered list of player edits (tiny; replayable).

---

## 7. MVP Scope (first playable)

**In:**
- One hand-made grid map, ~9 intersections, 2 road widths.
- Cars with lane-aware queuing, box-blocking, and spillback.
- Intersection editor: lane turn assignment, stop/yield/all-way stop, fixed-time signals with phase ring, protected/permitted lefts.
- Demand growth + AM/PM peak.
- Flow / delay / gridlock HUD; game over.

**Out (post-MVP):**
- Roundabouts, overpasses, one-way conversion, actuated signals, coordination, events, multiple cities, daily challenge, audio.

**MVP success test:** a player with no traffic engineering background can look at a jammed intersection, guess "it needs a left-turn lane and a protected left phase", do it in under 20 seconds, and *see* the queue drain.

---

## 8. Open Questions

- Should cars ever be allowed to U-turn or pick a different destination when delayed too long? (Pro: realism and self-healing. Con: hides your mistakes.)
- Pedestrian phases: a real signal constraint, and a nice late-game complexity — or just noise?
- Is "roads are fixed" too restrictive for late game? Possible compromise: very rare, very expensive "add one lane" tokens.
- Score: total flow, or flow weighted by delay (penalizing jams rather than just rewarding volume)?
