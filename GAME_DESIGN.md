# Gand — Game Design Document

> Working title. A minimalist traffic-engineering game in the spirit of *Mini Motorways*, except you never draw the road network. The city is already built. You are the traffic engineer: you design intersections, assign lanes, set storage lengths, time signals, manage driveways and curbs, and keep **people** moving as demand grows.

---

## 1. Pitch

**One sentence:** *Mini Motorways*, but the roads are fixed and the only thing you control is how traffic moves through them.

**Fantasy:** You are the person nobody thanks when the morning commute is smooth and everybody blames when it isn't.

**Core loop (30–90 seconds):**
1. Watch traffic. Spot a queue forming.
2. Diagnose *why* with the instruments (turning counts, v/c, O-D highlight, time-space diagram).
3. Open the intersection or segment, draft a redesign, preview it, commit.
4. Watch the queue drain — or discover you pushed the jam one block downstream.

**Win/lose:** Endless mode: survive as long as possible; the game ends when the gridlock meter fills. Scenario mode: hit a target within a fixed window.

---

## 2. What Makes It Different From Mini Motorways

| Mini Motorways | Gand |
|---|---|
| You draw roads between houses and destinations | Road alignments are fixed; you can't add or remove roads |
| Upgrades are coarse (roundabout, traffic light, motorway) | Intersections are fully designable: lanes, pocket lengths, phases, timings, ped treatment, geometry |
| Traffic is abstracted | Traffic is lane-aware: cars queue in the lane that matches their turn, pockets overflow, boxes get blocked, buses stop in-lane |
| Cars are the unit | **People** are the unit: a full bus outscores 30 single-occupant cars |
| Failure = a destination's queue overflows | Failure = an intersection gridlocks (spillback + cross-blocking) |
| Pressure comes from new houses spawning | Pressure comes from demand growth, tidal peaks, events, incidents and new generators you can't refuse |

The ownership is clear: **topology is given, flow is yours.**

---

## 3. Core Systems

### 3.1 The Map

- A grid-ish city on a fixed canvas. Roads are pre-laid and their *alignment* never changes.
- **Starting widths:** nearly every road starts as **1+1**. One or two **arterials start pre-widened at 2+2** so the lane-assignment puzzle is visible from day one. All other widening is earned (§3.9).
- **Block length** is a fixed property of each segment and matters constantly: it caps turn-pocket storage, bounds queue storage between signals, and governs how fast spillback reaches the upstream node.
- **Trip generators** (houses, offices, shops, a stadium, a school, a hospital) connect to the network through **driveways** (§3.5). They spawn trips between each other on a schedule, measured in **people**, not vehicles.
- **Intersections** are the primary editable unit. **All start uncontrolled** with all turns permitted. The first jam at an uncontrolled 4-way *is* the tutorial.
- **Road segments** are the second editable unit (§3.4).
- **Curbs** are the third (§3.6).

### 3.2 Vehicles and People

| Vehicle | People | Length | Accel | Notes |
|---|---|---|---|---|
| Car | 1–2 (avg 1.3) | 4.5 m | normal | The bulk of traffic |
| Bus | 0–60 by load | 12 m | slow | Follows a fixed route; stops at stops; eligible for signal priority |
| Truck | 1 | 16 m | very slow | Needs large turn radius; some turns impossible without corner geometry |
| Emergency | 1 | 6 m | fast | Rare; triggers signal pre-emption; stuck = heavy score hit |

Every vehicle:
- Has an origin driveway, destination driveway, and a precomputed route; re-routes periodically on observed travel times (§3.7).
- Chooses a lane one segment ahead based on its next turn. If that lane is full it **queues behind the lane in the adjacent lane and blocks it** — the primary jam-propagation mechanism.
- Obeys control (signals, stops, yields, priority rules), gap-acceptance for unprotected movements, right-on-red where enabled.
- **Won't enter an intersection it can't clear** (box protection) unless the player disables it per node. Box blocking is what turns slow into gridlocked.
- Has a **patience** meter. Low patience → aggressive gap acceptance, yellow running, and a small chance of ignoring a turn restriction. Patience exhaustion feeds the gridlock meter.
- **Compliance** is < 100%: a slice of drivers ignore new turn restrictions for the first in-game day after a change.

### 3.3 Intersection Editor

Click an intersection to open the editor: a top-down close-up of just that node with its approaches. The simulation keeps running at half speed while editing (or paused, in draft mode — §3.11).

#### 3.3.1 Lanes and geometry

Per approach:
- **Turn permission per lane**: Left / Through / Right / U-turn in any combination (shared Through+Right etc.). The game greys out combinations that create unresolvable conflicts.
- **Turn pockets** (left or right): carved from the approach. Two parameters:
  - **Storage length** (slider, metres, capped by block length minus taper). *Too short and the pocket overflows into the through lane; the through lane is now a left lane.* This is the single most common real-world failure and the game's best teachable moment. Pocket storage costs lane-km (§3.9).
  - **Source**: narrow the existing lanes (free, −10% saturation flow per narrowed lane) or take width from the median / parking (if present).
- **Lane drop placement** (when the downstream segment has fewer lanes): drop *after* the node (through lanes continue, merge happens downstream) or *before* (merge upstream of the queue). Zipper vs. taper merge style.
- **Right-turn channelisation**: a slip lane with a pedestrian island, built as a real lane with its own storage (default 40 m, settable). Right turns leave the through lanes, never wait for the signal and never consume phase time; the movement has no vehicle conflicts in the box. **Yield** mode gives way to traffic merging onto the same exit; **free-flow** mode (needs an 80 m+ block for the acceleration lane) does not. The island shortens the main crossing by one lane (shorter pedestrian minimum green) and turners yield to pedestrians crossing the slip. Costs 0.04 lane-km, refundable; not available on tight corners or at roundabouts. Trade-off the sim enforces: if the through queue reaches past the slip's entry, right-turners are trapped behind it — storage length matters here exactly as it does for left pockets.
- **Median**: open (lefts allowed), closed (no lefts — forces U-turns downstream), or **median U-turn crossover** (the Michigan-left building block).
- **Corner radius**: tight (compact, trucks can't turn right), standard, or wide (trucks fine, pedestrians cross further).

#### 3.3.2 Control type

| Type | Behaviour | Unlock |
|---|---|---|
| Uncontrolled | Right-hand priority, gap acceptance. Fine at low volume. | Start |
| Two-way stop / Yield | Minor approaches stop or yield; major flows freely. | Start |
| All-way stop | Everyone stops. Fair, slow, capped throughput. | Start |
| Signal | Full phase design (§3.3.3). The main tool. | Early |
| Roundabout | Replaces the node. Excellent for balanced flows, poor when one approach dominates. Structure token. | Mid |
| Innovative forms | MUT, RCUT, CFI, DDI (§3.3.5). Structure tokens. | Late |
| Interchange | Grade separation with ramps (§3.3.6). Expensive. | Late |

#### 3.3.3 Signal design

- **Phase ring**: add phases, drag to reorder, assign movements (arrows) to each. Conflicting movements can't share a phase.
- **Cycle length** (slider, 40–180 s). Longer = more capacity, longer waits, bigger platoons.
- **Lost time is always visible.** Each phase change costs yellow + all-red (computed from approach speed, ~4–6 s). The editor shows: *Cycle 90 s · Phases 4 · Lost 18 s · Efficiency 80%.* More phases = less green. This is the central signal trade-off and it is never hidden.
- **Splits**: green time per phase. Auto-balance button sets splits proportional to critical-lane volume (and shows you the v/c result).
- **Left-turn treatment** per approach: Protected / Permitted / Protected+Permitted / Split phasing. **Leading vs lagging** left.
- **Right on red** per approach.
- **Overlaps**: a right turn can run during the compatible left from the cross street.
- **Pedestrian treatment** (§3.3.4) — imposes minimum phase lengths.
- **Actuation** (unlock): phases are skipped with no demand and extended up to a max while a detector sees vehicles. Detectors are placed by the player:
  - **Stop-bar detector**: calls the phase; basic.
  - **Advance detector** (placed 60–120 m back): extends green for arriving platoons and protects the **dilemma zone** (reduces red-light running and crashes).
- **Coordination** (unlock): link signals on a corridor, set a shared cycle and an **offset** per signal. The **time-space diagram** (§3.10) draws the green band.
- **Metering** (unlock): deliberately shorten an upstream green so the queue forms where there is storage instead of at a critical node that would cross-block. The ugly twin of coordination.
- **Transit signal priority** (unlock): an approaching bus can extend green or truncate the opposing red by up to N seconds, once per cycle.
- **Emergency pre-emption**: automatic; drops to the emergency vehicle's movement, then recovers. Causes a short-term mess.

#### 3.3.4 Pedestrians

- Every intersection has crosswalks on each approach (removable, at a walkability penalty that reduces nearby generator demand slightly).
- A crosswalk imposes a **minimum phase length** on the parallel vehicle phase: walk + clearance = crossing distance / 1.2 m/s. Wide roads mean long minimum phases on the cross street whether or not any cars want them. Narrowing the crossing (islands, curb extensions) shortens it.
- Pedestrians conflict with turning vehicles. Options:
  - **Concurrent** (default): turns yield to peds in the crosswalk. Cheap, but turn capacity collapses with heavy ped volume.
  - **Leading pedestrian interval**: peds get 3–7 s head start. Safer; costs green.
  - **Exclusive ped phase / scramble**: all vehicles stop; peds cross any direction. Great for ped-heavy nodes, expensive in lost time.
  - **Channelised right with island** (§3.3.1): moves the conflict out of the signal.
- **Mid-block crossings**: placeable on segments. Unsignalised (vehicles yield, friction) or signalised (actuated by ped demand).
- Pedestrian demand comes from generators and from **bus stops** — a busy stop produces a crossing surge after each bus.

#### 3.3.5 Innovative intersection forms

Each eliminates a conflict in a different way, with a different footprint. Unlocked progressively; each costs structure tokens.

| Form | What it does | Needs | Weakness |
|---|---|---|---|
| **Median U-turn (MUT)** | Removes all lefts from the main node; lefts become through → U-turn downstream → right. Two-phase main signal. | Wide median on arterial, crossover storage | Extra travel for left-turners; crossover capacity |
| **RCUT / Superstreet** | Minor-street through and left are eliminated; minor traffic turns right, U-turns, comes back. Main street signals run independently in each direction. | Median, two U-turn crossovers | Minor street delay; counterintuitive |
| **Continuous Flow Intersection (CFI)** | Lefts cross the oncoming lanes at a secondary signal *before* the main node, so they run concurrently with through traffic. | Footprint for displaced left lanes | Complex, coordination-sensitive |
| **Diverging Diamond (DDI)** | At an interchange, crossing traffic to the left side between ramp terminals makes all ramp movements free. | Interchange | Pedestrian path is in the middle; driver confusion |
| **Roundabout** (single/double lane) | Yield-on-entry; eliminates left-turn conflicts and most severe crash types. | Footprint | Dominant approach starves others; peds; two-lane lane-choice confusion |

#### 3.3.6 Interchanges

Grade separation is never "just an overpass" — it's an interchange with ramps, and ramps have merge/diverge problems. Forms: **Diamond**, **SPUI** (single-point), **DDI**, **Partial cloverleaf**. Each has ramp terminals that are themselves editable intersections, and ramp lengths that bound merge storage. Cost: 3 structure tokens + lane-km for ramps. Limit 2 per city.

### 3.4 Road Segment Editor

Click a segment between two intersections:
- **Widen**: add one lane in one direction. Costs lane-km (§3.9), one in-game day of construction with a lane closed. Removing a lane refunds 100%.
- **Reallocate** (free): e.g. 2+2 → 3+1 (tidal flow), 1+1 + centre turn lane (TWLTL), bus lane, bike lane.
- **One-way** conversion (structure token, not refunded). Cars reroute. Big capacity gain on that corridor, big headache for everyone who used the other direction.
- **Mid-block turn restrictions** (free): e.g. no left into a driveway.
- **Lane drop / merge** style (§3.3.1).
- **Design speed**: tied to lane width and parking presence rather than a free knob. Narrow lanes + parking = slow street: lower saturation flow, but shorter yellow, smaller dilemma zone, lower crash severity, and a ped-friendly bonus for adjacent generators.
- **Mid-block crossing** placement (§3.3.4).
- **Bus stop** placement (§3.8).

### 3.5 Access Management — Driveways

Trip generators don't spawn traffic from nowhere; they connect via **driveways**, and a strip of driveways on an arterial is what kills it.

Per generator:
- **Driveway position** along its frontage (drag). Keep it away from the intersection's functional area or it conflicts with the turn pocket.
- **Consolidate**: two adjacent generators share one driveway (free, requires both frontages).
- **Right-in / right-out only** (free): the median closes across the driveway; left-in/left-out traffic U-turns downstream.
- **Relocate to the side street** (costs lane-km for the connector).
- **Frontage road** (structure token): one access point for several generators.
- **Driveway throat length**: short throats back up into the street when the parking lot is slow (the stadium, the school at 3 pm).

Driveway density per segment feeds the **conflict count** (§3.9.3) and friction on the through lanes.

### 3.6 Curb Management

On 1+1 and 2+2 streets the curb is where the spare capacity hides.
- **On-street parking** (default on most locals): eats effective width, adds friction from cars pulling in/out. Removing it gives a lane. Doing so lowers nearby shop demand a little (a soft push-back).
- **Peak-hour parking ban** (free, reversible): the curb is a travel lane 7–9 am and 4–6 pm, parking otherwise. The cheap tidal lane.
- **Loading zones**: without one, delivery trucks **double-park** in a travel lane for 2–5 minutes. With one, they don't.
- **Bus bays vs curbside stops** (§3.8).
- **Curb extensions** (bulb-outs): shorten the ped crossing (shorter minimum phases), kill a parking space, slow turning vehicles.

### 3.7 Routing and Driver Behaviour

- **Time-dependent shortest path** on the segment graph using recent observed travel times (exponentially smoothed). A fraction of vehicles re-route every N seconds, so one-ways and restrictions actually divert traffic and the network self-balances.
- **Perceived cost** includes a penalty per stop and a small penalty for unprotected lefts — drivers avoid them, which is why your beautifully protected left is empty and the next block's unprotected one is jammed.
- **Variable message signs** (unlock): a placeable sign at a decision point that shifts a share of route choice toward an alternative. Soft tool, cheap, imperfect compliance.
- **Lane utilisation imbalance**: drivers favour the lane that continues straight downstream; the lane that drops is under-used until it's forced.
- **Shockwaves**: stop-and-go propagates upstream in a saturated lane; visible as a moving wave of brake lights.

### 3.8 Transit

- Two or three **bus routes** are fixed per city (like roads, you don't draw them). You control everything about how they move.
- **Stops**: curbside (bus blocks the lane for dwell time — 15–40 s) or **bus bay** (pulls out of traffic; costs curb, bus takes longer to re-merge). Near-side vs far-side of the intersection: far-side plays better with signal priority.
- **Bus lane** (lane reallocation): removes a car lane, moves more people if the bus is full. Cars can enter it to turn right unless you make it a protected lane.
- **Queue jump**: a short bus-only lane plus an early green at the stop line.
- **Transit signal priority** (§3.3.3).
- Buses carry people, and **people are the score**, so a route that moves 600 people an hour justifies a lot of car delay — and a nearly-empty bus doesn't.

### 3.9 Resources, Construction and Risk

#### 3.9.1 No money
Like *Mini Motorways*, pressure comes from scarcity of a **physical** resource on a weekly cadence. Difficulty is one number: weekly lane-km.

**Always free and instant** — the iterate-watch-iterate loop is never gated:
signal timing, phases, splits, cycle, left-turn treatment, right-on-red, actuation settings, detector placement, offsets, metering, TSP; turn permissions; control type among uncontrolled / yield / stop / AWSC / signal; lane reallocation within existing width; stop-line pocket *narrowing*; parking bans; driveway right-in/right-out; mid-block turn restrictions; ped treatment choices.

**Two spendable resources:**

| Resource | Spent on | Earned | Refund |
|---|---|---|---|
| **Lane-km** | Widening (0.1 lane-km per 100 m per lane); pocket storage beyond the taper; driveway relocation connectors; interchange ramps. | Fixed weekly allotment. One-time bonus when a new generator opens. | 100% on removal — experimentation is cheap, *placement* is the constraint. |
| **Structure tokens** | Roundabout (1), one-way conversion (1), MUT/RCUT (1), CFI (2), frontage road (1), interchange (3). | Weekly choice: **one token or a bonus lane-km allotment**, never both. | Roundabout/MUT/RCUT/CFI/interchange: 100%. One-way and frontage road: not refunded. |

#### 3.9.2 Construction and disruption
Widening, pockets, roundabouts, innovative forms and interchanges close a lane at that location for one in-game day. You cannot widen your way out of a jam *during* rush hour — you either planned it last night or you fix it now with the free tools. This keeps signals relevant late.

#### 3.9.3 Safety and incidents
Every node and segment has a **conflict score**: unprotected lefts × volume, speed differential at merges, driveway density, dilemma-zone exposure, ped-vehicle conflicts. Conflict score sets the **crash probability** per hour.

A crash blocks a lane (or the whole intersection for a severe one) for 10–40 minutes. Roundabouts and protected lefts reduce severe crashes; high design speed and short yellows increase them. **Safety is not a separate score — it is a flow concern.** The instruments show conflict score per node so you can see where the next crash will be.

Other incidents: **signal malfunction** (node drops to flashing red = all-way stop until you click it), **stalled vehicle**, **double-parked truck** (no loading zone), **rain** (−10% saturation flow city-wide for a few hours).

### 3.10 Instruments

Engineers spend most of their time looking, not building. The HUD is slim; the instruments are deep.

**Always-on HUD:** People moved / hour · Average person-delay · **Gridlock meter** · Day & week · Lane-km balance · Token count.

**Per node (hover / zoom):** Level of Service A–F badge · conflict score dot.

**Instrument panel (toggleable overlays):**
- **Turning movement counts**: live demand per arrow at every node.
- **v/c ratio** per movement; red above 0.9.
- **Delay heatmap** across the city.
- **Queue length** overlay with max-queue-this-hour ghost.
- **Time-space diagram** for a selected corridor: the green band, the platoon trajectories, your offsets. *The* coordination tool.
- **O-D highlight**: click any jammed movement; the map lights up where those vehicles came from and where they're going. Half the time the answer to "why is this left jammed" is a shortcut three blocks away.
- **Conflict overlay**: crash risk per node/segment.
- **Transit overlay**: bus positions, load, schedule adherence.
- **Pedestrian overlay**: crossing volumes and ped delay.
- **History graphs**: any metric vs time for the last 3 days.

### 3.11 Draft Mode

Open an editor → **Draft**. The sim pauses. Make any number of edits (even across several nodes). **Preview** runs a 5-minute headless simulation of the current traffic with the draft applied and shows the predicted change in delay, v/c and queue per movement. **Commit** or **Discard**. Removes the frustration of making a bad change during rush hour, and lets you tune a corridor's offsets as a set.

### 3.12 Pressure Curve

Difficulty comes from demand and chance, not from new topology.
- **Steady growth**: people-trips/hour increase each in-game day.
- **Tidal peaks**: AM inbound, PM outbound. Tidal flow and peak-hour parking bans matter.
- **Events**: stadium lets out (10,000 people in 30 min); school at 3 pm (speed zone + ped surge + parent pick-up double-parking); roadworks close a segment for a week; a parade closes an arterial for an afternoon; a crash on the highway dumps traffic onto your arterial.
- **New generators**: a mall opens on an already-strained corridor with a badly placed driveway. You can't say no, but you can fix the driveway.
- **Incidents** (§3.9.3) scale with your own conflict scores — a safe network is a quieter one.

### 3.13 Score

**People-hours of delay avoided**, i.e. people completing trips weighted by how close to free-flow they travelled. A huge gridlock-adjacent throughput scores below a smaller smooth one. Separate tracked stats (not score, but shown): crashes, worst-approach delay (equity), bus schedule adherence.

---

## 4. Modes and Progression

### 4.1 Modes
- **Endless**: a city, growing demand, survive. The main mode.
- **Scenario**: fixed map, a brief, a target, a time window. *"The hospital says ambulances are stuck at 5th & Main. Average delay on 5th < 45 s by Friday."* Scenarios teach one concept each and are the tutorial track.
- **Daily challenge**: fixed seed and allotment, 10 in-game days, leaderboard on score.
- **Sandbox**: unlimited resources, any city, for learning and for making corridors you're proud of.

### 4.2 Unlocks (persist across runs)

| Milestone | Unlock |
|---|---|
| Tutorial scenarios 1–3 | Signals, protected lefts, pocket storage, right-on-red |
| Scenario 4–6 | Lost time / cycle tuning, ped treatments, curb tools |
| Endless day 10 | Actuation + detectors, driveway tools |
| Endless day 15 | Coordination + time-space diagram, metering |
| Endless day 20 | Roundabouts, bus lanes + TSP, one-way |
| Endless day 25 | MUT, RCUT, channelised rights, VMS |
| Endless day 30 | CFI, interchanges (diamond, SPUI) |
| Endless day 40 | DDI, frontage roads |
| Per city milestones | New cities: grid · radial · river with 3 bridges · highway-with-exits · old-town irregular |

---

## 5. Art, Feel, Audio

- **Visual:** flat, minimalist, high contrast. Roads are mid-grey ribbons; lane markings crisp white; vehicles are small saturated shapes coloured by destination type; buses are long and obvious. Signals are small coloured dots at the stop line when zoomed in and a phase ring when zoomed out.
- **Readability over realism.** Queue length legible at a glance. Box-blocked nodes pulse. Pocket overflow shows as a spill of the pocket's colour into the through lane.
- **Camera:** smooth zoom from whole-city to single node. Editors are modal zooms, not screens.
- **Audio:** ambient lo-fi; soft ticks on phase changes; a chord when a queue drains; a rumble as the gridlock meter fills; a bus's doors as a gentle rhythm. No horns.
- **Time control:** pause, 1×, 2×, 4×. Editing is always allowed, including while paused.

---

## 6. Technical Notes

### 6.1 Simulation model
- **Discrete lanes, continuous position.** Each lane is a 1D track; vehicles are points with length and velocity. Car-following via IDM — cheap, produces realistic shockwaves. Vehicle classes differ in length, acceleration, desired speed and turn radius.
- **Pockets are lanes** with a start offset; a vehicle enters a pocket from the adjacent lane in the taper zone if there is a gap and room; otherwise it waits in the adjacent lane and blocks it.
- **Intersections as conflict matrices.** Each movement (approach × lane × turn) has a conflict set. Control grants right-of-way to non-conflicting sets. Uncontrolled nodes resolve by priority + gap acceptance. Pedestrians are movements too, with their own conflict sets.
- **Signal controller** is a ring-barrier controller: phases, splits, min/max green from ped clearance and settings, yellow/all-red from approach speed, actuation via detector zones, coordination via a master clock and offsets, TSP and pre-emption as controlled interrupts.
- **Innovative forms** are node transforms: a MUT replaces one node with a 2-phase node plus two crossover nodes and re-routes left movements; the rest of the sim is unchanged.
- **Routing:** time-dependent Dijkstra on the lane-group graph with smoothed observed travel times, stop penalties and unprotected-left penalties; staggered periodic re-routing of a fraction of vehicles.
- **Spillback:** a lane's entry closes when storage is full; this propagates queues and causes box blocking.
- **Incidents** are lane blockers with a timer, spawned from per-node conflict score × exposure.
- **Draft/preview** forks the sim state, runs N minutes headless, diffs metrics.
- **Everything is deterministic** given a seed and an ordered command log. Save = seed + commands. Replays and daily challenges fall out for free.

### 6.2 Tick budget
Target 500–2000 vehicles at 60 fps in a browser. Fixed 10 Hz physics step, interpolated rendering. Per-lane sorted arrays make car-following O(n).

### 6.3 Stack
- TypeScript. **The sim has no DOM dependency**: it is unit-testable and runs headless for balancing, previews and CI.
- Renderer (later): canvas or PixiJS, reads sim state read-only.
- Vitest for tests. Seeded RNG. Command pattern for all player edits.

---

## 7. Engine Status (what is built)

The headless simulation engine lives in `sim/` (TypeScript, no DOM, deterministic, 39 tests). Everything below is implemented and exercised by the test suite and the balancing harness; rendering is the only layer not built.

| Area | Implemented |
|---|---|
| Network | Fixed road alignments, two-way/one-way links, lanes with per-lane turn permissions, turn pockets with storage length and overflow into the through lane, lane drops before/after a node, medians (none/open/closed/TWLTL), parking lanes and peak-hour bans, bus bays, mid-block crossings, driveways with throat storage, median U-turn crossovers. |
| Conflicts | Chord-based conflict matrix per node (cross / merge / ped-hard / ped-soft), U-turn handling, roundabout arc conflicts, slip-lane separation. CFI: physical displaced-left bays entered through a pre-signal slaved to the main signal, with departing traffic held at the crossover. Interchanges: off-ramp pockets carrying every exit (they overflow onto the mainline when too short) and on-ramp merge lanes. |
| Control | Uncontrolled (priority-to-the-right + gap acceptance), two-way stop, yield, all-way stop (FIFO), roundabouts (1–2 lanes), channelised right-turn slip lanes (yield / free-flow, with island), signals: phase ring, explicit lost time (yellow + all-red from approach speed), cycle, splits, protected / permitted / protected+permitted / split lefts, leading/lagging, right-on-red, channelised rights, ped minimum greens from crossing width, LPI, exclusive and scramble phases, actuation with stop-bar and advance detectors (gap-out, dilemma-zone hold), coordination with offsets, dynamic metering against a downstream link, transit signal priority (extend/truncate), emergency pre-emption, malfunction → flashing red. Permitted-left "sneakers" clear on yellow. |
| Vehicles | IDM car-following; cars, buses, trucks (corner radius), emergency vehicles; lane choice and mandatory/discretionary lane changes; box protection and box blocking; patience, improvisation when stuck in the wrong lane; non-compliance; left-in across traffic (blocks the lane unless a TWLTL exists); right-in/right-out. |
| Demand | Land-use production/attraction profiles with AM/PM/lunch/school peaks, O-D choice with affinity and distance decay, people per vehicle, bus mode share where routes serve both ends, trucks to shops, surges from events, generators opening on later days. |
| Transit | Fixed bus loops, headway-based fleet sizing, curbside stops (block the lane) vs bays, boarding/alighting dwell, bus lanes (cars may use unprotected ones to turn right), bus-only queue-jump pockets, TSP. |
| Routing | Time-dependent Dijkstra with observed travel times, control-delay and v/c penalties, unprotected-left discomfort, crossover U-turn edges, closed-link avoidance, periodic re-routing, VMS steering with partial compliance. |
| Resources | Lane-km (widen, pockets beyond the free taper, driveway connectors), structure tokens (roundabout 1, one-way 1, MUT/RCUT 1, CFI 2, interchange 3), weekly allotment with the token-or-lanes choice, 100 % refunds where the doc says so, one-day construction closures. |
| Incidents & events | Conflict score from exposure × unresolved conflicts, driveway density, ped conflicts and dilemma-zone exposure → crashes (lane or node blocking), stalls, double-parked deliveries without a loading zone, parking manoeuvres, signal faults; scheduled stadium let-outs, school pick-up, roadworks, parades, highway dumps, rain. |
| Instruments | People/hour, person-delay, gridlock meter, LOS per node, HCM-style capacities and v/c per movement, turning movement counts, O-D highlight for a movement, time–space data per corridor, delay heatmap, queue histories, conflict and transit overlays, HUD summary. |
| Game | `Game` with pause/1×/2×/4×, every edit as a validated `Command`, draft mode with headless preview and commit/discard, seed + command-log saves and exact replay, scenarios with goals and tool unlocks, endless mode with daily growth, date-seeded daily challenge on procedural cities, scheduled city growth, pavement wear and repaving. |

### Balancing

Three maps ship with the engine: **Tutorial** (3×3 grid, one arterial), **Radial** (inner ring of jobs, outer ring of homes, four 2+2 spokes — strongly tidal) and **River** (homes west, jobs east, three bridges — tidal through chokepoints).

A **playtest bot** (`sim/src/bot/engineer.ts`) plays as a reactive engineer: every ten in-game minutes it reads the instruments and applies the fix a competent player would — signals with detectors where conflict or demand warrants, two-way stops where a minor street is light, pockets and protected phases where a left saturates, longer pockets when they overflow, more green or a longer cycle for saturated throughs, slip lanes for saturated rights, parking bans then parking removal then widening for the worst link, roundabouts at balanced minor nodes, and the weekly token-or-lanes choice. Every action is logged with its reason.

Survival with and without the bot, 16-day runs, two seeds each (`sim/src/cli/multi.ts`):

| Map | No intervention | Bot | Peak people/h (none → bot) |
|---|---|---|---|
| Tutorial | day 7.5 | **day 12** | 1,970 → 2,590 |
| Radial | day 7.5 | **day 10** | 2,140 → 2,410 |
| River | day 5.5 | **day 7** | 1,980 → 2,150 |

Scripted fixed plans on the tutorial map, for reference: stops everywhere day 4; all uncontrolled day 10; arterial signals with permitted lefts day 10; arterial signals, actuated, protected lefts + 60 m pockets **day 14**.

Two findings from the bot that shaped the sim: (1) an *early* version of the bot made things worse on every map, because it signalised too eagerly and because vehicles approached uncontrolled crossings at full speed — everyone now creeps on approach to an uncontrolled node, and the bot uses a stricter signal warrant; (2) a peak-hour parking lane that reverted while vehicles were still landing in it stranded drivers in a lane with no permitted turns — a real bug the bot found in an hour.

### Dynamic maps

The road *alignment* stays fixed within a run in the sense that matters — the player never draws a road — but the map is no longer static:

- **Procedural cities** (`sim/src/maps/procedural.ts`): a seeded generator makes 3–5 × 3–4 grids with one or two 2+2 arterials (open or TWLTL medians), zoned land use (homes west/north, jobs east/south, shops on the arterial), a school, usually a hospital, a stadium that opens mid-run, gateways at the arterial ends plus random edge stubs, a bus loop, and a growth schedule. Same seed, same city.
- **Daily challenge** (`sim/src/game/daily.ts`): the date hashes to a seed; everyone gets the same procedural city, ten in-game days, 1.0 lane-km a week, and a score to compare.
- **City growth** (`MapDef.growth`, applied in `tick.ts`): on scheduled days the *city* adds a development — a new stub road off an edge node with a free leg, plus its land use. The attached node gets a new leg; if it is signalised its plan is rebuilt (keeping the player's left treatments), a two-way stop adds the stub to its minor street, and the developer pays 0.2 lane-km toward access. A `new-road` event announces it. A node that already has four legs refuses growth.
- **Pavement wear** (`Link.wear`): every vehicle pass wears the link — cars ×1, buses ×4, trucks ×8 per kilometre, a nod to the fourth-power law — and severe crashes scar it. Worn pavement lowers free speed (up to −30 %), saturation flow (−15 %) and multiplies the stall rate (×5 at full wear). **Repave** costs 0.015 lane-km per 100 m and closes a lane for a construction day; the pavement overlay shows worst roads first. Nothing else degrades permanently.

The playtest bot handles all of this; two findings from running it on procedural cities: construction must be rationed (it once opened five widening sites at once, each closing a lane for a day, and gridlocked the city it was trying to save — it now builds one site at a time and never in a peak), and procedural seeds vary widely in difficulty, which is what a daily challenge wants.

### Road geometry and the intricate bits

- **Grade and curvature** per road (`MapRoadDef.grade`, `curvature`). Trucks crawl uphill (−8 % speed per % grade), buses −5 %, cars −2 %. A downhill approach needs a longer yellow (ITE `t + v/(2a + 2Gg)` with the grade term). Curves and crests cut **sight distance**; where a driver could not stop within it, the approach speed is capped and gap acceptance needs 0.5–1.5 s more. Restricted sight multiplies the node's conflict score — an uncontrolled crossing you can't see into is where the crashes are.
- **Skew**: legs are placed in right-angle slots but keep their true angle; the deviation lengthens clearance paths (longer all-red) and widens critical gaps.
- **Offset intersections**: two T-junctions joined by a road under 60 m. The instrument lists them; `realignOffset` merges them into one four-leg node for 0.1 lane-km × the land multiplier and keeps the surviving node's control. Procedural cities grow one 60 % of the time.
- **Weaving sections**: where an on-ramp merge lane is followed by an off-ramp pocket on the same link, entering and exiting traffic must cross. Speeds drop with intensity (1 − length/300 m), discretionary lane changes are suppressed, and `weavingSections` warns under 150 m.
- **Storage vs discharge** (`storageReport`): vehicles a block can hold versus what the upstream signal releases per cycle; ratio > 0.9 is spillback risk. The bot answers it with metering.
- **Right-of-way as the land budget**: each road has a `frontage` — open ×1, parkland ×2, built ×3, water ×6 on widening cost — and a `maxWidth` cap. Roads with homes, offices or shops become built automatically; stadium lots stay open. Which corridor you can afford to widen is now a geography question.
- **Clearance as a choice** (`setClearance`): yellow and all-red can be trimmed up to 1.5 s each. Every second stolen shows up as cycle efficiency *and* as a clearance deficit that raises the crash score on every approach.
- **Lead/lag per approach** (`setLeftLead`): lead one protected left and lag the opposite one to shift that direction's through green; `bandwidthReport` measures the progression band along a corridor so the time–space tuning has a number.

### Tutorial chain

Ten scenarios, one concept each, with pre-broken setups and tool unlocks (`sim/src/game/scenarios.ts`): First Signal → Lost Time (a 150 s split-phase mess) → The Short Pocket (20 m, overflowing) → Permitted-Left Starvation → Who Gets the Green (splits/actuation) → The Mall Opens (driveways) → Move People, Not Cars (bus lane/TSP) → Green Wave (offsets) → The Roundabout Question (balanced vs dominant flows) → Match Day (metering through a stadium let-out). Then endless mode on each of the three maps.

## 8. MVP Scope (first playable)

**In:**
- One hand-made grid map, ~9 intersections. All roads 1+1 except one 2+2 arterial. Driveways on every generator.
- Cars and one bus route, lane-aware queuing, pockets with storage length and overflow, spillback, box blocking.
- Intersection editor: lane turn assignment; pocket storage; uncontrolled / stop / yield / AWSC / fixed-time signals with phase ring, cycle, visible lost time, protected/permitted/split lefts, right-on-red; concurrent ped crossings with minimum phase lengths.
- Segment editor: widen, reallocate, peak-hour parking ban, bus stop curbside/bay.
- Driveway: move, right-in/right-out.
- Routing with re-routing; demand growth with AM/PM peaks.
- Weekly lane-km, construction day, 100% refunds. No tokens yet.
- Instruments: TMC, v/c, queue overlay, O-D highlight, draft/preview.
- People-based score, delay, gridlock meter, game over.

**Out (post-MVP):** roundabouts, innovative forms, interchanges, actuation, coordination/time-space, metering, TSP, incidents, curb beyond parking ban, VMS, events, scenarios beyond the tutorial, audio.

**MVP success test:** a player with no traffic engineering background can look at a jammed intersection, read the TMC and v/c, guess "the left pocket is too short and it needs a protected phase", fix it in under 30 seconds, and *see* the queue drain.

---

## 9. Open Questions

- Weekly lane-km allotment: scale with city size, or stay flat so the late game is genuinely starved?
- Weekly token-or-lanes choice: card pick (legible, interrupting) or quiet menu?
- Should pedestrians be a separate score component or stay purely a constraint + conflict source?
- How much driver non-compliance is fun vs. infuriating? Start at 5% for one day after a change.
- Should crashes be visible as a "could have been avoided" post-mortem (shows the conflict that caused it)? Probably yes — it's a teaching moment.
