/**
 * The runtime model the application works with.
 *
 * Decoded once from the wire format, then never re-derived. Bulk point data lives in
 * flat typed arrays (structure-of-arrays) rather than an object per point: rendering and
 * — later — heatmap binning are tight loops over hundreds of thousands of values, and an
 * object graph would allocate 87,599 objects and scatter them across the heap.
 *
 * See DATA_MODEL.md §8.
 */

import type { MapConfig, MapId } from '../utils/coordinates';
import type { ActorType, EventName, IdFormat } from './types';

export interface JourneyModel {
  /** Stable integer id, assigned by the pipeline. Index into `Dataset.journeys`. */
  id: number;
  userId: string;
  /** Index into `Dataset.matches`. */
  match: number;
  mapId: MapId;
  date: string;
  /** Original day folder. Provenance only — it misfiles 436 rows; `date` is authoritative. */
  sourceFolder: string;
  actorType: ActorType;
  /** The dataset README's id rule, retained so its classification stays reconstructible. */
  idFormat: IdFormat;
  /** True where `actorType` and `idFormat` disagree — 17 journeys. */
  actorIdConflict: boolean;
  startTRel: number;
  durationSec: number;
  sampleCount: number;
  eventCounts: Readonly<Record<EventName, number>>;
}

export interface MatchModel {
  id: number;
  /** Full match id including the `.nakama-0` suffix. */
  matchId: string;
  mapId: MapId;
  /** Epoch seconds. The anchor for match-relative time. */
  startedAt: number;
  durationSec: number;
  journeys: number[];
  /**
   * True when only one journey was captured — 743 of 796 matches. The UI must state
   * this rather than implying the roster was empty. See UX_SPEC.md §12.
   */
  isPartialRoster: boolean;
}

export interface MapModel {
  id: MapId;
  displayName: string;
  config: MapConfig;
  image: {
    url: string;
    thumbnailUrl: string;
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
  };
  worldBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  uvBounds: { minU: number; maxU: number; minV: number; maxV: number } | null;
  totals: { journeys: number; matches: number; rows: number };
}

/**
 * All points for one map, every journey concatenated and ordered by (journey, tRel).
 *
 * `offsets` has length `journeyCount + 1`; journey slot `i` owns indices
 * `offsets[i] .. offsets[i + 1]`.
 */
export interface MapTracks {
  mapId: MapId;
  journeyCount: number;
  pointCount: number;
  /** Slot -> journey id. */
  journeyIds: Int32Array;
  offsets: Uint32Array;

  worldX: Float32Array;
  worldZ: Float32Array;
  u: Float32Array;
  v: Float32Array;
  /** Seconds since match start. Max observed 890. */
  tRel: Uint16Array;
  eventType: Uint8Array;
  /** Point -> journey slot, for reverse lookup during hit-testing. */
  journeySlot: Uint32Array;
}

export interface DataQualityNote {
  category: string;
  severity: 'warning' | 'critical';
  count: number;
  detail: string;
}

/** Everything loaded at boot. Track data is fetched per map, on demand. */
export interface Dataset {
  contentHash: string;
  totals: {
    sourceRows: number;
    rows: number;
    journeys: number;
    matches: number;
    players: number;
  };
  dates: string[];
  dropped: { duplicateFileRows: number; duplicateRows: number };
  dataQuality: DataQualityNote[];

  maps: MapModel[];
  mapsById: ReadonlyMap<MapId, MapModel>;
  matches: MatchModel[];
  journeys: JourneyModel[];

  /** Prebuilt inverted indexes. See DATA_MODEL.md §10. */
  journeysByMap: ReadonlyMap<MapId, number[]>;
  journeysByDate: ReadonlyMap<string, number[]>;
  matchesByMap: ReadonlyMap<MapId, number[]>;
}
