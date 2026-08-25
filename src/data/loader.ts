/**
 * Fetches and decodes the pipeline's output into the runtime model.
 *
 * This is the only module that knows the wire format exists.
 */

import { MAP_CONFIGS, getMapConfig, isUvInBounds, worldToUv } from '../utils/coordinates';
import type { MapId } from '../utils/coordinates';
import type {
  Dataset,
  JourneyModel,
  MapModel,
  MapTracks,
  MatchModel,
} from './model';
import {
  EVENT_NAMES,
  EXPECTED_SCHEMA_VERSION,
  MOVEMENT_CODES,
  type EventName,
  type WireIndex,
  type WireManifest,
  type WireMap,
  type WireTracks,
} from './types';

/** Distinguishes expected failures (surfaced in the UI) from programmer error. */
export class DataLoadError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'schema' | 'parse',
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'DataLoadError';
  }
}

/** Vite's BASE_URL keeps this working when hosted under a sub-path. */
function dataUrl(path: string): string {
  const base = import.meta.env.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}data/${path}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = dataUrl(path);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw new DataLoadError(
      `Couldn't reach ${path}.`,
      'network',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (!response.ok) {
    throw new DataLoadError(
      `Couldn't load ${path}.`,
      'network',
      `HTTP ${response.status} ${response.statusText}`,
    );
  }
  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new DataLoadError(
      `${path} is not valid JSON.`,
      'parse',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

function decodeMap(wire: WireMap): MapModel {
  const image = wire.image;
  // Fall back to the source artwork dimensions if the build skipped image generation,
  // and to a square as a last resort, so aspect handling always has real numbers.
  const naturalWidth = image.naturalWidth ?? image.width ?? 1024;
  const naturalHeight = image.naturalHeight ?? image.height ?? naturalWidth;
  return {
    id: wire.id,
    displayName: wire.displayName,
    config: getMapConfig(wire.id),
    image: {
      url: dataUrl(image.url),
      thumbnailUrl: dataUrl(image.thumbnailUrl),
      width: image.width ?? naturalWidth,
      height: image.height ?? naturalHeight,
      naturalWidth,
      naturalHeight,
    },
    worldBounds: wire.worldBounds,
    uvBounds: wire.uvBounds,
    totals: wire.totals,
  };
}

function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Loads the manifest, map metadata and journey index. Track data is fetched per map. */
export async function loadDataset(): Promise<Dataset> {
  const [manifest, mapsPayload, index] = await Promise.all([
    fetchJson<WireManifest>('manifest.json'),
    fetchJson<{ maps: WireMap[] }>('maps.json'),
    fetchJson<WireIndex>('index.json'),
  ]);

  // Refuse to render against an unexpected contract: a mismatched schema could place
  // points in the wrong location while looking entirely plausible.
  if (manifest.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new DataLoadError(
      `Data schema mismatch.`,
      'schema',
      `This build expects schema v${EXPECTED_SCHEMA_VERSION} but the data is ` +
        `v${manifest.schemaVersion}. Re-run: python scripts/build_data.py`,
    );
  }
  for (const [name, code] of Object.entries(manifest.eventCodes)) {
    if (EVENT_NAMES[code] !== name) {
      throw new DataLoadError(
        'Event dictionary mismatch.',
        'schema',
        `Data maps ${name} to code ${code}; this build expects ${EVENT_NAMES[code]}.`,
      );
    }
  }

  const maps = mapsPayload.maps.map(decodeMap);
  const mapsById = new Map<MapId, MapModel>(maps.map((m) => [m.id, m]));

  const dict = index.dictionaries;
  const mc = index.matches;
  const jc = index.journeys;

  const matchJourneys: number[][] = Array.from({ length: mc.count }, () => []);
  for (let i = 0; i < jc.count; i++) matchJourneys[jc.match[i]!]!.push(i);

  const matches: MatchModel[] = [];
  for (let i = 0; i < mc.count; i++) {
    const journeys = matchJourneys[i]!;
    matches.push({
      id: i,
      matchId: mc.matchId[i]! + dict.matchSuffix,
      mapId: dict.mapId[mc.mapId[i]!]!,
      startedAt: mc.startedAt[i]!,
      durationSec: mc.durationSec[i]!,
      journeys,
      isPartialRoster: journeys.length <= 1,
    });
  }

  const journeys: JourneyModel[] = [];
  const journeysByMap = new Map<MapId, number[]>();
  const journeysByDate = new Map<string, number[]>();
  for (let i = 0; i < jc.count; i++) {
    const match = matches[jc.match[i]!]!;
    const date = dict.date[jc.date[i]!]!;
    const counts = {} as Record<EventName, number>;
    const row = jc.eventCounts[i]!;
    for (let c = 0; c < EVENT_NAMES.length; c++) counts[EVENT_NAMES[c]!] = row[c] ?? 0;

    journeys.push({
      id: i,
      userId: jc.userId[i]!,
      match: jc.match[i]!,
      mapId: match.mapId,
      date,
      sourceFolder: dict.sourceFolder[jc.sourceFolder[i]!]!,
      actorType: dict.actorType[jc.actorType[i]!]!,
      idFormat: dict.idFormat[jc.idFormat[i]!]!,
      actorIdConflict: jc.actorIdConflict[i] === 1,
      startTRel: jc.startTRel[i]!,
      durationSec: jc.durationSec[i]!,
      sampleCount: jc.sampleCount[i]!,
      eventCounts: counts,
    });
    pushInto(journeysByMap, match.mapId, i);
    pushInto(journeysByDate, date, i);
  }

  const matchesByMap = new Map<MapId, number[]>();
  for (const match of matches) pushInto(matchesByMap, match.mapId, match.id);

  return {
    contentHash: manifest.contentHash,
    totals: {
      sourceRows: manifest.source.rows,
      rows: manifest.processed.rows,
      journeys: manifest.processed.journeys,
      matches: manifest.processed.matches,
      players: manifest.processed.players,
    },
    dates: manifest.processed.dates,
    dropped: manifest.dropped,
    dataQuality: manifest.dataQuality,
    maps,
    mapsById,
    matches,
    journeys,
    journeysByMap,
    journeysByDate,
    matchesByMap,
  };
}

/**
 * Loads one map's track data and decodes it into flat typed arrays.
 *
 * UV is derived here rather than transmitted: it is an exact affine function of the
 * world coordinates, so shipping both would waste roughly 180 KB. The transform is the
 * validated one from `utils/coordinates`, shared with the Python pipeline and covered by
 * cross-language parity tests.
 */
export async function loadMapTracks(mapId: MapId, coordinateScale = 100): Promise<MapTracks> {
  const wire = await fetchJson<WireTracks>(`tracks/${mapId}.json`);
  const config = MAP_CONFIGS[mapId];

  const journeyCount = wire.tracks.length;
  let pointCount = 0;
  for (const track of wire.tracks) pointCount += track.t.length;

  const tracks: MapTracks = {
    mapId,
    journeyCount,
    pointCount,
    journeyIds: new Int32Array(journeyCount),
    offsets: new Uint32Array(journeyCount + 1),
    worldX: new Float32Array(pointCount),
    worldZ: new Float32Array(pointCount),
    u: new Float32Array(pointCount),
    v: new Float32Array(pointCount),
    tRel: new Uint16Array(pointCount),
    eventType: new Uint8Array(pointCount),
    journeySlot: new Uint32Array(pointCount),
  };

  let cursor = 0;
  for (let slot = 0; slot < journeyCount; slot++) {
    const track = wire.tracks[slot]!;
    tracks.journeyIds[slot] = track.j;
    tracks.offsets[slot] = cursor;

    for (let i = 0; i < track.t.length; i++) {
      const x = track.x[i]! / coordinateScale;
      const z = track.z[i]! / coordinateScale;
      const { u, v } = worldToUv(x, z, config);
      tracks.worldX[cursor] = x;
      tracks.worldZ[cursor] = z;
      tracks.u[cursor] = u;
      tracks.v[cursor] = v;
      tracks.tRel[cursor] = track.t[i]!;
      tracks.eventType[cursor] = track.e[i]!;
      tracks.journeySlot[cursor] = slot;
      cursor++;
    }
  }
  tracks.offsets[journeyCount] = cursor;

  if (cursor !== pointCount) {
    throw new DataLoadError(
      `Track data for ${mapId} is inconsistent.`,
      'parse',
      `decoded ${cursor} points but expected ${pointCount}`,
    );
  }
  return tracks;
}

/** True when a point is a `Position` or `BotPosition` sample. */
export function isMovement(eventType: number): boolean {
  return MOVEMENT_CODES.has(eventType);
}

/** Development-time assertion that every decoded point lands on the minimap. */
export function countOffMap(tracks: MapTracks): number {
  let off = 0;
  for (let i = 0; i < tracks.pointCount; i++) {
    if (!isUvInBounds({ u: tracks.u[i]!, v: tracks.v[i]! })) off++;
  }
  return off;
}
