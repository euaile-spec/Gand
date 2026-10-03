/**
 * The whole simulation state is plain JSON-serialisable data: no class instances,
 * no object cross-references (ids only). This makes save files, replays and
 * draft/preview forks (structuredClone) trivial and keeps the sim deterministic.
 *
 * Units: metres, seconds, radians. Right-hand traffic. Screen coords (y down).
 */
import type { Point, Ring } from '../core/util.js';
import type { RngState } from '../core/rng.js';

// ───────────────────────────── identifiers ─────────────────────────────
export type NodeId = string;
export type RoadId = string;
export type LinkId = string; // `${roadId}>` forward, `${roadId}<` backward
export type LaneId = string; // `${linkId}#${index}` or `${linkId}#pL` / `#pR` / `#bay${n}`
export type VehicleId = number;
export type GeneratorId = string;
export type RouteId = string;
export type StopId = string;
export type IncidentId = number;

// ───────────────────────────── geometry / turns ─────────────────────────────
/** Leg slot around a node, clockwise from north. Nodes have ≤ 4 legs. */
export type Leg = 0 | 1 | 2 | 3;
export type Turn = 'L' | 'T' | 'R' | 'U';
export const TURNS: readonly Turn[] = ['L', 'T', 'R', 'U'];

/** A vehicle movement through a node: enters from `fromLink`, performs `turn`, exits on `toLink`. */
export interface Movement {
  key: string; // `${fromLink}:${turn}`
  fromLink: LinkId;
  toLink: LinkId;
  turn: Turn;
  entryLeg: Leg;
  exitLeg: Leg;
  /** Path length through the node. */
  length: number;
  /** Speed cap inside the node for this movement. */
  speed: number;
}

/** Pedestrian crossing of leg `leg` at a node. Key `ped:${leg}`. */
export interface PedCrossing {
  key: string;
  leg: Leg;
  enabled: boolean;
  /** Crossing distance in metres (sets min walk+clearance). */
  width: number;
  /** Pedestrians waiting / crossing. */
  waiting: number;
  crossingUntil: number; // sim time when current crossers are clear, 0 if none
  /** Accumulated ped delay (person-seconds) for metrics. */
  delayAccum: number;
  served: number;
}

export type ConflictKind = 'none' | 'cross' | 'merge' | 'ped-hard' | 'ped-soft';

// ───────────────────────────── lanes & links ─────────────────────────────
export type LaneType = 'general' | 'bus' | 'bike' | 'parking' | 'pocket' | 'bay';

export interface Lane {
  id: LaneId;
  linkId: LinkId;
  /** 0 = leftmost (median side). Pockets/bays use -1 (left pocket) or lanes.length (right side). */
  index: number;
  type: LaneType;
  /** Position range along the link that this lane physically exists on. */
  start: number;
  end: number;
  width: number; // metres; narrow lanes reduce saturation flow
  allowed: Turn[]; // turns permitted at the downstream node from this lane
  /** Vehicle ids sorted by position descending (front of queue first). */
  vehicles: VehicleId[];
  /** Blockage (incident/construction/double-parking): vehicles cannot pass `blockedAt`. */
  blockedAt: number | null;
  /** True for a protected bus lane (cars may not enter even to turn). */
  protectedBus?: boolean;
  /** Pocket is a bus queue-jump (buses only). */
  busOnly?: boolean;
}

export type ParkingMode = 'none' | 'always' | 'peak-ban';

export interface Driveway {
  generatorId: GeneratorId;
  /** The link whose right-hand curb carries the driveway (right-in / right-out side). */
  linkId: LinkId;
  pos: number; // along that link
  access: 'full' | 'right-in-right-out';
  throatLength: number; // metres of internal queue storage
  /** Vehicles waiting to exit onto the street. */
  exitQueue: VehicleId[];
  /** Vehicles waiting (in the leftmost lane of the opposite link) to turn left in — tracked for friction. */
  leftInWaiting: number;
  /** When a shared driveway, the ids of generators consolidated here. */
  sharedWith: GeneratorId[];
}

export interface BusStop {
  id: StopId;
  linkId: LinkId;
  pos: number;
  kind: 'curbside' | 'bay';
  /** Far side of the downstream node (pos near link end) matters for TSP; informational. */
  waiting: Record<RouteId, number>; // people waiting per route
  nearSide: boolean;
}

export interface MidblockCrossing {
  id: string;
  linkId: LinkId; // crossing spans both directions of the road; stored once on the forward link
  pos: number;
  signalised: boolean;
  waiting: number;
  activeUntil: number; // vehicles must stop while > t
  demandPerHour: number;
}

export interface Vms {
  nodeId: NodeId;
  /** Link to steer traffic away from (cost multiplier) for vehicles passing the node. */
  avoidLink: LinkId;
  multiplier: number; // > 1
  compliance: number; // 0..1
}

export interface Link {
  id: LinkId;
  roadId: RoadId;
  from: NodeId;
  to: NodeId;
  length: number;
  speedLimit: number; // m/s, derived from design (lane width, parking)
  /** General/bus/bike lanes left→right. Parking lane is appended with type 'parking'. */
  lanes: Lane[];
  /** Turn pockets at the downstream end. */
  pocketLeft: Lane | null;
  pocketRight: Lane | null;
  /** Bus bays. */
  bays: Lane[];
  parking: ParkingMode;
  loadingZone: boolean;
  curbExtensions: boolean;
  driveways: Driveway[];
  busStops: BusStop[];
  crossings: MidblockCrossing[];
  /** Mid-block restriction: turns into driveways on this link that are banned. */
  noLeftIntoDriveways: boolean;
  /** Lane drop at downstream end handled by Lane.end < length. Merge style affects friction. */
  mergeStyle: 'taper' | 'zipper';
  /** Observed travel time (EWMA) for routing. */
  travelTime: number;
  freeFlowTime: number;
  /** Per-link detectors for the routing graph's stop penalty — count of controlled stops. */
  stopPenalty: number;
  /** Design speed given the physical cross-section. */
  designSpeed: number;
  /** Under construction until this time; lanes closed meanwhile. 0 = none. */
  constructionUntil: number;
  /** Grade-separated free-flow link (bridge) — no node control at its ends. */
  bridge?: boolean;
}

export interface Road {
  id: RoadId;
  a: NodeId;
  b: NodeId;
  length: number;
  /** Total physical width in lane units (both directions + parking + median). Fixed per road unless widened. */
  widthLanes: number;
  /** Lane counts assigned per direction. forward = a→b. */
  fwdLanes: number;
  bwdLanes: number;
  oneWay: 'none' | 'fwd' | 'bwd';
  median: 'none' | 'open' | 'closed' | 'twltl'; // twltl = centre two-way left turn lane
  /** Centre turn lane counts toward widthLanes. */
  points: Point[]; // polyline a→b
  crossovers: Crossover[];
}

// ───────────────────────────── control ─────────────────────────────
export type LeftTreatment = 'protected' | 'permitted' | 'protected-permitted' | 'split';
export type PedTreatment = 'concurrent' | 'lpi' | 'exclusive' | 'scramble';

export interface Detector {
  laneId: LaneId;
  /** Distance back from stop line. ~0 = stop bar; 60–120 = advance detector. */
  setback: number;
}

export interface Phase {
  id: number;
  /** Vehicle movement keys served. */
  movements: string[];
  /** Pedestrian crossing keys served (derived unless exclusive/scramble). */
  peds: string[];
  split: number; // target green seconds (fixed-time) / max green (actuated)
  minGreen: number;
  maxGreen: number;
  /** Phase is coordinated: its start is pinned to the master clock + offset. */
  coordinated: boolean;
  /** Dynamic metering: when `meterLink` occupancy exceeds threshold, cut this phase to minGreen. */
  meterLink: LinkId | null;
  meterThreshold: number; // 0..1 occupancy
  /** Leading pedestrian interval seconds (vehicles that soft-conflict wait). */
  lpi: number;
}

export type SignalState = 'green' | 'yellow' | 'all-red';

export interface SignalPlan {
  phases: Phase[];
  cycle: number;
  /** Which approaches may turn right on red. */
  rightOnRed: Record<LinkId, boolean>;
  leftTreatment: Record<LinkId, LeftTreatment>;
  pedTreatment: PedTreatment;
  actuated: boolean;
  detectors: Detector[];
  coordinated: boolean;
  offset: number;
  /** Transit signal priority. */
  tsp: boolean;
  tspMaxExtend: number;
  /** Leading (default) vs lagging lefts, informational for the auto-builder; phase order encodes it. */
  laggingLeft: boolean;
}

export interface SignalRuntime {
  phaseIdx: number;
  state: SignalState;
  stateStart: number;
  greenStart: number;
  /** Time the detector last saw a vehicle in the current phase (for gap-out). */
  lastCall: number;
  /** Per-phase: has demand (actuated). */
  calls: boolean[];
  tspUsedThisCycle: boolean;
  cycleStart: number;
  /** Pre-emption: movement key being served for an emergency vehicle, if any. */
  preempt: string | null;
  preemptUntil: number;
  /** Malfunction → flashing red (behaves as all-way stop) until reset. */
  malfunction: boolean;
  /** Current green interval log for time-space diagrams: [start,end] pairs by phase. */
  greenLog: { phase: number; start: number; end: number }[];
}

export type ControlType =
  | 'uncontrolled'
  | 'two-way-stop'
  | 'yield'
  | 'all-way-stop'
  | 'signal'
  | 'roundabout';

export interface Control {
  type: ControlType;
  /** For two-way-stop / yield: links that must stop/yield (minor). */
  minorLinks: LinkId[];
  signal: SignalPlan | null;
  runtime: SignalRuntime | null;
  /** Roundabout lanes (1 or 2). */
  roundaboutLanes: number;
}

export type NodeForm = 'standard' | 'mut-main' | 'mut-crossover' | 'rcut-main' | 'rcut-crossover' | 'cfi-main' | 'cfi-crossover' | 'interchange-terminal' | 'ddi-terminal';

export interface NodeLeg {
  leg: Leg;
  roadId: RoadId;
  /** Inbound link (toward this node) and outbound link (away), null if one-way the other way. */
  inLink: LinkId | null;
  outLink: LinkId | null;
  angle: number; // heading from node centre out along this leg
  /** Right-turn slip lane with island: right turns bypass the signal, yield to peds on island side. */
  channelisedRight: boolean;
  cornerRadius: 'tight' | 'standard' | 'wide';
  /** Lane-drop placement for vehicles leaving on this leg: after node (merge downstream) vs before. */
  laneDrop: 'after' | 'before';
}

export interface NodeMetricsLive {
  /** Control delay accumulated this window and vehicles served, for LOS. */
  delayAccum: number;
  served: number;
  los: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  /** Turning movement counts per movement key over the current 15-min window. */
  tmcWindow: Record<string, number>;
  tmcLast: Record<string, number>;
  tmcWindowStart: number;
  /** Arrivals per movement over the rolling window (veh/h), for v/c. */
  demand: Record<string, number>;
  capacity: Record<string, number>;
  conflictScore: number;
  /** Seconds the node has been box-blocked continuously. */
  boxBlockedFor: number;
  crashes: number;
}

export interface SimNode {
  id: NodeId;
  pos: Point;
  legs: NodeLeg[];
  movements: Record<string, Movement>;
  /** conflicts[a][b] for movement/ped keys. */
  conflicts: Record<string, Record<string, ConflictKind>>;
  peds: Record<string, PedCrossing>;
  control: Control;
  boxProtection: boolean;
  form: NodeForm;
  /** Movement keys currently banned (e.g. lefts at a MUT main node). */
  banned: string[];
  /** Vehicle ids currently inside the node. */
  occupants: VehicleId[];
  /** Arrival order at stop line for all-way stop. */
  stopQueue: VehicleId[];
  metrics: NodeMetricsLive;
  vms: Vms | null;
  /** Node radius (half of the intersection box) for geometry. */
  radius: number;
  /** For crossover/terminal nodes: the parent node id of the transform. */
  parent?: NodeId;
  /** Conflict overrides (CFI/DDI): pairs that no longer conflict. */
  conflictOverrides?: [string, string][];
}

// ───────────────────────────── vehicles ─────────────────────────────
export type VehicleClass = 'car' | 'bus' | 'truck' | 'emergency';

export interface VehicleParams {
  length: number;
  maxAccel: number;
  comfortDecel: number;
  desiredSpeedFactor: number; // × speed limit
  headway: number; // T
  minGap: number; // s0
  people: number;
  /** Minimum corner radius this vehicle can take right turns on: 'tight' corners block trucks. */
  needsWideCorner: boolean;
}

export type VehiclePlace =
  | { kind: 'lane'; laneId: LaneId; pos: number }
  | { kind: 'node'; nodeId: NodeId; movement: string; pos: number }
  | { kind: 'driveway'; linkId: LinkId; generatorId: GeneratorId }
  | { kind: 'done' };

export interface Vehicle {
  id: VehicleId;
  cls: VehicleClass;
  people: number;
  place: VehiclePlace;
  speed: number;
  accel: number;
  /** Route as a sequence of link ids, including the current one at routeIdx. */
  route: LinkId[];
  routeIdx: number;
  originGen: GeneratorId | null;
  destGen: GeneratorId | null;
  /** Destination driveway position on the final link; null for bus/through-trips exiting at a sink node. */
  destPos: number | null;
  spawnTime: number;
  freeFlowTime: number;
  /** Seconds spent stopped or < 1 m/s. */
  delay: number;
  /** 0..1, drains when stopped, refills when moving. */
  patience: number;
  /** Lane-change intent: target lane id (null = none) and urgency 0..1. */
  laneChangeTarget: LaneId | null;
  /** Time of arrival at stop line (for AWSC ordering) or 0. */
  stopLineArrival: number;
  /** Has come to a full stop at the current stop line (stop control). */
  hasStopped: boolean;
  /** Stop control: seconds stopped at line. */
  stoppedFor: number;
  /** Bus: route id and next stop index. */
  busRoute: RouteId | null;
  busStopIdx: number;
  dwellUntil: number;
  /** Next time this vehicle may re-route. */
  nextReroute: number;
  /** Driver ignores new turn restrictions for a while (non-compliance). */
  nonCompliant: boolean;
  /** Set when the driver gives up on the correct lane and takes whatever turn the lane allows. */
  improvising: boolean;
  /** Vehicle is stationary for a planned reason (bus dwell, parking manoeuvre). */
  dwelling: boolean;
  /** Entered-node time, for box-block detection. */
  nodeEnterTime: number;
  /** Timestamp when the vehicle ran a red / violated a lane restriction (conflict scoring). */
  violations: number;
  /** Sim time the vehicle entered its current link (travel-time sampling). */
  linkEnterT: number;
  /** Delay accumulated on the approach to the next node (control delay for LOS). */
  approachDelay: number;
  /** Bus: route loops forever. */
  cyclic: boolean;
  /** Waiting at a median crossover or for a left-in gap, out of the lane (TWLTL). */
  waitingOffLane: boolean;
  /** Vehicle is at a crossover / left-in and has waited this long. */
  waitStart: number;
  lastLaneChangeT: number;
}

/** Median U-turn crossover (MUT / RCUT building block) or CFI pre-signal on a road. */
export interface Crossover {
  id: string;
  roadId: RoadId;
  /** Position along the forward link; the backward position is length − pos. */
  pos: number;
  kind: 'uturn' | 'cfi-presignal';
  /** Which directions may U-turn here. */
  fwd: boolean;
  bwd: boolean;
  signalised: boolean;
  /** Storage length of the U-turn bay (metres). */
  storage: number;
  /** Vehicles currently waiting in the bay per direction. */
  waitingFwd: VehicleId[];
  waitingBwd: VehicleId[];
}

// ───────────────────────────── demand ─────────────────────────────
export type GeneratorKind = 'house' | 'office' | 'shop' | 'school' | 'stadium' | 'hospital' | 'depot' | 'external';

export interface Generator {
  id: GeneratorId;
  kind: GeneratorKind;
  /** People capacity / size → scales production & attraction. */
  size: number;
  /** The road it fronts; driveway lives on one of its links. */
  roadId: RoadId;
  pos: Point;
  /** Driveway details are stored on the link (Link.driveways). This is the link id for lookup. */
  drivewayLink: LinkId;
  /** Opens at this day (0 = from start). Inactive generators produce nothing. */
  opensDay: number;
  active: boolean;
  /** Lost trips because the driveway throat was full. */
  lostTrips: number;
  /** Walkability bonus affects demand modestly (bulb-outs, nearby crossings). */
  walkability: number;
  /** Event hook: stadium 'letting out' surge until time. */
  surgeUntil: number;
  surgePeople: number;
}

export interface BusRoute {
  id: RouteId;
  /** Ordered links the bus traverses (a loop); stops reference positions on these links. */
  links: LinkId[];
  stops: StopId[];
  headway: number; // seconds between buses
  nextDispatch: number;
  depotLink: LinkId;
  /** Average load factor to translate waiting passengers into people moved. */
  activeBuses: VehicleId[];
  /** Schedule adherence metric: seconds late, EWMA. */
  lateness: number;
}

// ───────────────────────────── resources / economy ─────────────────────────────
export interface Resources {
  laneKm: number;
  tokens: number;
  weeklyLaneKm: number;
  /** When true the player must choose 'token' | 'lanes' before the week proceeds. */
  pendingWeeklyChoice: boolean;
  spentLaneKm: number; // total committed in widenings/pockets (for refund tracking)
  unlocks: string[];
}

export interface Construction {
  id: number;
  kind: 'widen' | 'pocket' | 'roundabout' | 'transform' | 'interchange' | 'connector';
  linkId: LinkId | null;
  nodeId: NodeId | null;
  laneId: LaneId | null; // lane closed during works
  completesAt: number;
  /** Applied on completion. */
  payload: unknown;
}

// ───────────────────────────── incidents / events ─────────────────────────────
export type IncidentKind = 'crash' | 'severe-crash' | 'stall' | 'double-parked' | 'parking-manoeuvre' | 'signal-malfunction';

export interface Incident {
  id: IncidentId;
  kind: IncidentKind;
  laneId: LaneId | null;
  nodeId: NodeId | null;
  pos: number;
  until: number;
  /** For post-mortem: which conflict produced the crash. */
  cause: string;
}

export type EventKind = 'stadium-letout' | 'school-pickup' | 'roadworks' | 'parade' | 'highway-dump' | 'rain' | 'new-generator';

export interface WorldEvent {
  id: number;
  kind: EventKind;
  start: number;
  end: number;
  target: string | null; // generator / road / link id
  announced: boolean;
  applied: boolean;
  /** For roadworks/parade: the lane ids closed. */
  closedLanes: LaneId[];
}

// ───────────────────────────── metrics ─────────────────────────────
export interface TripRecord {
  people: number;
  delay: number;
  travel: number;
  freeFlow: number;
  completedAt: number;
  cls: VehicleClass;
}

export interface Metrics {
  /** Rolling hour of completions. */
  recent: TripRecord[];
  peopleMoved: number;
  peopleDelaySeconds: number;
  tripsCompleted: number;
  score: number;
  gridlock: number; // 0..1, game over at 1
  gridlockPeakToday: number;
  crashes: number;
  worstApproachDelay: number;
  /** Per-link average delay EWMA (s/veh), heatmap. */
  linkDelay: Record<LinkId, number>;
  /** Queue length history per lane, one sample per minute, metres. */
  queueHistory: Record<LaneId, Ring>;
  /** Minute samples: people/hour, avg delay, gridlock. */
  history: { t: number; flow: number; delay: number; gridlock: number; vehicles: number }[];
  pedDelaySeconds: number;
  busLateness: number;
  violations: number;
  lostTrips: number;
}

// ───────────────────────────── world ─────────────────────────────
export interface WorldConfig {
  /** Sim seconds per in-game day. Physics is real-time; the day is compressed. */
  dayLength: number;
  daysPerWeek: number;
  /** Demand multiplier growth per day (1.0 = flat). */
  growthPerDay: number;
  baseTripsPerHourPerSize: number;
  tickDt: number;
  rerouteInterval: number;
  rerouteShare: number;
  nonComplianceShare: number;
  nonComplianceDays: number;
  patienceDrainPerSec: number;
  patienceRecoverPerSec: number;
  improviseBelow: number;
  gridlockFillPerSec: number;
  gridlockDrainPerSec: number;
  crashRateScale: number;
  busShare: number; // share of trips that take a bus if both ends served
  truckShare: number;
  constructionDays: number;
  previewSeconds: number;
  rainSatFlowFactor: number;
}

export interface World {
  t: number;
  day: number;
  week: number;
  config: WorldConfig;
  rng: RngState;
  nodes: Record<NodeId, SimNode>;
  roads: Record<RoadId, Road>;
  links: Record<LinkId, Link>;
  lanes: Record<LaneId, Lane>;
  vehicles: Record<VehicleId, Vehicle>;
  nextVehicleId: number;
  generators: Record<GeneratorId, Generator>;
  busRoutes: Record<RouteId, BusRoute>;
  busStops: Record<StopId, BusStop>;
  resources: Resources;
  constructions: Construction[];
  nextConstructionId: number;
  incidents: Incident[];
  nextIncidentId: number;
  events: WorldEvent[];
  nextEventId: number;
  metrics: Metrics;
  demandMultiplier: number;
  /** Set when gridlock ≥ 1. */
  gameOver: boolean;
  /** Time of the last structural edit per node (for non-compliance window). */
  lastEditAt: Record<string, number>;
  /** Weather: 1.0 normal; < 1 rain. */
  satFlowFactor: number;
  /** Corridors defined by the player for time-space diagrams: ordered node ids. */
  corridors: Record<string, NodeId[]>;
  /** Interchanges: bridge links by parent node. */
  interchanges: Record<NodeId, { bridgeLinks: LinkId[]; terminals: NodeId[]; form: 'diamond' | 'spui' | 'ddi' | 'parclo' }>;
  /** Number of structures built (for limits). */
  structureCounts: Record<string, number>;
}

export const DEFAULT_CONFIG: WorldConfig = {
  dayLength: 3600,
  daysPerWeek: 7,
  growthPerDay: 1.06,
  baseTripsPerHourPerSize: 1.6,
  tickDt: 0.1,
  rerouteInterval: 60,
  rerouteShare: 0.3,
  nonComplianceShare: 0.05,
  nonComplianceDays: 1,
  patienceDrainPerSec: 1 / 150,
  patienceRecoverPerSec: 1 / 30,
  improviseBelow: 0.05,
  gridlockFillPerSec: 1 / 120,
  gridlockDrainPerSec: 1 / 60,
  crashRateScale: 1,
  busShare: 0.25,
  truckShare: 0.04,
  constructionDays: 1,
  previewSeconds: 300,
  rainSatFlowFactor: 0.9,
};

export const VEHICLE_PARAMS: Record<VehicleClass, VehicleParams> = {
  car: { length: 4.5, maxAccel: 2.0, comfortDecel: 2.8, desiredSpeedFactor: 1.05, headway: 1.2, minGap: 2.0, people: 1.3, needsWideCorner: false },
  bus: { length: 12, maxAccel: 1.0, comfortDecel: 2.0, desiredSpeedFactor: 0.95, headway: 1.6, minGap: 3.0, people: 25, needsWideCorner: true },
  truck: { length: 16, maxAccel: 0.8, comfortDecel: 1.8, desiredSpeedFactor: 0.9, headway: 1.8, minGap: 3.5, people: 1, needsWideCorner: true },
  emergency: { length: 6, maxAccel: 3.0, comfortDecel: 4.0, desiredSpeedFactor: 1.4, headway: 0.8, minGap: 2.0, people: 1, needsWideCorner: false },
};

export const LANE_WIDTH_STANDARD = 3.5;
export const LANE_WIDTH_NARROW = 3.0;
export const SAT_FLOW_BASE = 1900; // veh/h/lane at standard width
export const PED_WALK_SPEED = 1.2;
export const PED_WALK_INTERVAL = 7;
export const LOS_THRESHOLDS: [number, 'A' | 'B' | 'C' | 'D' | 'E'][] = [
  [10, 'A'],
  [20, 'B'],
  [35, 'C'],
  [55, 'D'],
  [80, 'E'],
];
