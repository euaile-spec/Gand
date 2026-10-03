/** Plain map definition format consumed by the world builder. */
import type { GeneratorKind, ParkingMode } from '../model/types.js';

export interface MapNodeDef {
  id: string;
  x: number;
  y: number;
}

export interface MapRoadDef {
  id: string;
  a: string;
  b: string;
  /** Lanes per direction at start. */
  fwdLanes?: number;
  bwdLanes?: number;
  /** Total physical width in lane units; defaults to lanes + parking + median. */
  widthLanes?: number;
  parkingFwd?: ParkingMode;
  parkingBwd?: ParkingMode;
  median?: 'none' | 'open' | 'closed' | 'twltl';
  oneWay?: 'none' | 'fwd' | 'bwd';
  /** Optional polyline waypoints between a and b. */
  via?: { x: number; y: number }[];
}

export interface MapGeneratorDef {
  id: string;
  kind: GeneratorKind;
  size: number;
  roadId: string;
  /** Position along the road a→b, 0..1. */
  t: number;
  /** Which direction's right-hand curb the driveway sits on. */
  side: 'fwd' | 'bwd';
  opensDay?: number;
  throatLength?: number;
}

export interface MapBusRouteDef {
  id: string;
  /** Loop of node ids; consecutive nodes must share a road. */
  nodes: string[];
  headway: number;
  stops: { roadId: string; t: number; side: 'fwd' | 'bwd'; kind?: 'curbside' | 'bay' }[];
}

export interface MapDef {
  name: string;
  nodes: MapNodeDef[];
  roads: MapRoadDef[];
  generators: MapGeneratorDef[];
  busRoutes?: MapBusRouteDef[];
  /** Initial resources. */
  laneKm?: number;
  weeklyLaneKm?: number;
  tokens?: number;
}
