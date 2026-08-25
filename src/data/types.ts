/**
 * The contract emitted by `scripts/build_data.py`.
 *
 * These types mirror the wire format exactly, including its columnar and
 * dictionary-encoded shape. They are deliberately separate from the runtime model in
 * `model.ts`: the wire format optimises bytes, the runtime model optimises access.
 *
 * Nothing outside `loader.ts` should import the `Wire*` types.
 */

import type { MapId } from '../utils/coordinates';

export const EXPECTED_SCHEMA_VERSION = 1;

/** Pinned event dictionary. Codes are part of the wire contract. */
export const EVENT_NAMES = [
  'BotKill',
  'BotKilled',
  'BotPosition',
  'Kill',
  'Killed',
  'KilledByStorm',
  'Loot',
  'Position',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const EventCode = {
  BotKill: 0,
  BotKilled: 1,
  BotPosition: 2,
  Kill: 3,
  Killed: 4,
  KilledByStorm: 5,
  Loot: 6,
  Position: 7,
} as const satisfies Record<EventName, number>;

/** The two movement events. Exactly one appears per journey. */
export const MOVEMENT_CODES: ReadonlySet<number> = new Set([
  EventCode.Position,
  EventCode.BotPosition,
]);

export const KILL_CODES: ReadonlySet<number> = new Set([
  EventCode.Kill,
  EventCode.BotKill,
]);

export const DEATH_CODES: ReadonlySet<number> = new Set([
  EventCode.Killed,
  EventCode.BotKilled,
  EventCode.KilledByStorm,
]);

export type ActorType = 'human' | 'bot';
export type IdFormat = 'uuid' | 'numeric';

// --------------------------------------------------------------------------------------
// Wire format
// --------------------------------------------------------------------------------------

export interface WireManifest {
  schemaVersion: number;
  contentHash: string;
  eventCodes: Record<string, number>;
  coordinateScale: number;
  source: { files: number; rows: number };
  processed: {
    rows: number;
    journeys: number;
    matches: number;
    players: number;
    dates: string[];
  };
  dropped: { duplicateFileRows: number; duplicateRows: number };
  dataQuality: {
    category: string;
    severity: 'warning' | 'critical';
    count: number;
    detail: string;
  }[];
}

export interface WireMap {
  id: MapId;
  displayName: string;
  projection: { scale: number; originX: number; originZ: number };
  image: {
    url: string;
    thumbnailUrl: string;
    width: number | null;
    height: number | null;
    naturalWidth: number | null;
    naturalHeight: number | null;
  };
  worldBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  uvBounds: { minU: number; maxU: number; minV: number; maxV: number } | null;
  totals: { journeys: number; matches: number; rows: number };
}

export interface WireIndex {
  schemaVersion: number;
  dictionaries: {
    date: string[];
    sourceFolder: string[];
    mapId: MapId[];
    actorType: ActorType[];
    idFormat: IdFormat[];
    event: EventName[];
    matchSuffix: string;
  };
  matches: {
    count: number;
    matchId: string[];
    mapId: number[];
    startedAt: number[];
    durationSec: number[];
  };
  journeys: {
    count: number;
    userId: string[];
    match: number[];
    date: number[];
    sourceFolder: number[];
    actorType: number[];
    idFormat: number[];
    actorIdConflict: number[];
    startTRel: number[];
    durationSec: number[];
    sampleCount: number[];
    eventCounts: number[][];
  };
}

export interface WireTracks {
  map: MapId;
  tracks: { j: number; t: number[]; x: number[]; z: number[]; e: number[] }[];
}
