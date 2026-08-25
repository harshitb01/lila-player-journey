# Canonical Telemetry Data Model

The normalized model the application consumes. The frontend never sees the Parquet schema:
the offline pipeline is the only thing that reads `.nakama-0` files, and it emits a stable,
versioned contract.

Every size in this document is **measured**, not estimated. Reproduce with
`scripts/measure_encodings.py` (numbers current as of the Phase 1–2 dataset).

---

## 1. Design principles

1. **The journey is the grain.** One actor in one match. It is folder-independent, matches the
   file layout, and is the unit a Level Designer selects, filters and plays back.
2. **Separate the wire format from the runtime model.** The wire format optimises bytes; the
   runtime model optimises access. They are different shapes, converted once at load.
3. **Structure-of-arrays at runtime.** Rendering, heatmap binning and playback are all tight
   loops over hundreds of thousands of values. Arrays of objects would allocate 87,599 objects
   and scatter them across the heap.
4. **Never repeat a constant.** `map_id`, `match_id` and `user_id` are per-journey facts. Storing
   them per row is what makes the naive encoding **1,290 KB** instead of **433 KB** (§11).
5. **Carry the ambiguity.** Where the data is genuinely uncertain (the 17 conflicting actor ids,
   duplicate loot, missing extraction events), the model carries a flag rather than silently
   resolving it. See [DATA_QUALITY_DECISIONS.md](DATA_QUALITY_DECISIONS.md).

---

## 2. Core enumerations

```ts
type MapId = 'AmbroseValley' | 'GrandRift' | 'Lockdown';

type EventType =
  | 'Position' | 'BotPosition'                       // movement
  | 'Kill' | 'Killed' | 'BotKill' | 'BotKilled'      // combat
  | 'KilledByStorm'                                  // environment
  | 'Loot';                                          // item

type EventCategory = 'movement' | 'combat' | 'loot' | 'environment';

/** Operational classification: derived from movement vocabulary, never from user_id. */
type ActorType = 'human' | 'bot';

/** The dataset README's rule, preserved so its classification stays reconstructible. */
type IdFormat = 'uuid' | 'numeric';
```

**Event codes are pinned in the manifest**, not derived from sort order, so a new event type
cannot silently renumber existing data:

| Code | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| Event | `BotKill` | `BotKilled` | `BotPosition` | `Kill` | `Killed` | `KilledByStorm` | `Loot` | `Position` |

A `deathEvents` set (`Killed`, `BotKilled`, `KilledByStorm`) and `killEvents` set (`Kill`,
`BotKill`) are defined once in the model, so heatmap layers cannot drift apart from each other.

---

## 3. Map model

Static, tiny, always loaded. Three records total.

```ts
interface MapModel {
  id: MapId;
  displayName: string;                  // "Ambrose Valley"

  /** Projection constants, validated in COORDINATE_VALIDATION.md. */
  projection: { scale: number; originX: number; originZ: number };

  image: {
    url: string;                        // tracks/../minimaps/AmbroseValley.webp
    thumbnailUrl: string;
    width: number; height: number;      // delivered WebP dimensions
    naturalWidth: number;               // 4320 — the source artwork
    naturalHeight: number;              // 4320
  };

  /** Observed extent of real telemetry. Drives "dead space" analysis and auto-fit. */
  worldBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  uvBounds:    { minU: number; maxU: number; minV: number; maxV: number };

  /** Named locations. Only GrandRift's artwork carries these. */
  pointsOfInterest?: { name: string; u: number; v: number }[];

  totals: { journeys: number; matches: number; rows: number };
}
```

`naturalWidth/Height` is kept because GrandRift's source is **2160×2158**, not square. The
renderer needs the true aspect to avoid a 0.09% vertical stretch, and `uvToPixel` already takes
independent width and height.

**Points of interest** matter more than they look: GrandRift's minimap is a design map labelling
*Mine Pit*, *Burnt Zone*, *Engineer's Quarters*, *Labour Quarters*, *Cave House*, *Maintenance
Bay* and *Gas Station*. Those names are the vocabulary a Level Designer actually uses, so the
model has a slot for them rather than forcing "that blob at (0.42, 0.61)".

---

## 4. Event model

An event is a single telemetry row. It exists in two forms.

**Logical form** — what a hover tooltip or inspector receives:

```ts
interface TelemetryEvent {
  type: EventType;
  category: EventCategory;

  world: { x: number; z: number };      // raw game-space coordinates
  uv: { u: number; v: number };         // normalized minimap space, [0,1]

  tRel: number;                         // seconds since MATCH start
  tAbs: number;                         // epoch seconds (UTC), secondary label only

  journeyId: JourneyId;
}
```

**Physical form** — never materialised as objects in bulk. Bulk data lives in the flat typed
arrays of §8; a `TelemetryEvent` is constructed on demand for the one point under the cursor.

Both `world` and `uv` are present, as required. `uv` is *derived* at load time by one pass of
the validated transform rather than transmitted, because it is an exact affine function of
`world` — shipping both would add ~180 KB of perfectly redundant bytes.

---

## 5. Journey model

The index record. All 1,242 of these load up front; none contain positions.

```ts
type JourneyId = string;                // `${userId}|${matchId}` — folder-independent

interface JourneyModel {
  id: JourneyId;
  userId: string;                       // preserved verbatim, UUID or numeric
  matchId: string;                      // includes the .nakama-0 suffix
  mapId: MapId;

  /** Derived from ts, NOT from the day folder — the folder misfiles 436 rows. */
  date: string;                         // "2026-02-10"
  sourceFolder: string;                 // "February_11" — provenance, kept for audit

  actorType: ActorType;                 // movement vocabulary (operational)
  idFormat: IdFormat;                   // the README's rule (validation field)
  actorIdConflict: boolean;             // true for the 17 journeys where they disagree

  startTRel: number;                    // offset from match start, 0..5 s
  durationSec: number;
  sampleCount: number;                  // movement samples; 3 journeys have exactly 1
  eventCounts: Partial<Record<EventType, number>>;

  /** Slice into the map's flat runtime arrays. Assigned at load, not transmitted. */
  trackOffset: number;
  trackLength: number;
}
```

`actorType` + `idFormat` + `actorIdConflict` is the three-field arrangement decided in
[DATA_QUALITY_DECISIONS.md](DATA_QUALITY_DECISIONS.md): the operational answer, the alternative,
and a flag marking where they disagree. Nothing is lost and nothing is silently overridden.

---

## 6. Match model

```ts
interface MatchModel {
  id: string;
  mapId: MapId;

  startedAt: number;                    // epoch seconds — the match clock anchor
  date: string;
  durationSec: number;                  // max tRel across the match

  journeyIds: JourneyId[];
  humanCount: number;                   // by actorType
  botCount: number;

  eventCounts: Partial<Record<EventType, number>>;

  /** True for 743 of 796 matches. The UI must state this, not imply missing players. */
  isPartialRoster: boolean;
}
```

`isPartialRoster` exists because **93.3% of matches contain exactly one journey**. A match view
that silently shows one player looks broken; a match view that says "1 of an unknown roster
sampled" is honest. This is a data property, so it belongs in the model, not in view code.

`startedAt` is `min(ts_raw)` over the match — the anchor validated in §9e of
[DATA_ANALYSIS.md](DATA_ANALYSIS.md), where 53/53 multi-journey matches overlap in time.

---

## 7. Player model

```ts
interface PlayerModel {
  userId: string;
  idFormat: IdFormat;

  journeyIds: JourneyId[];
  matchIds: string[];
  mapIds: MapId[];
  dates: string[];

  /** A SET, not a single value. user_id 1429 appears as human in 14 matches, bot in 3. */
  observedActorTypes: ActorType[];
  hasConflictingActorType: boolean;

  totals: { journeys: number; rows: number; loot: number; kills: number; deaths: number };
}
```

The critical modelling decision here is that **`PlayerModel` carries no single `actorType`**.
`user_id 1429` is human-vocabulary in 14 journeys and bot-vocabulary in 3. A scalar field would
force a lie. Actor type is a property of a *journey*; the player record reports the set it was
observed in.

339 records: 245 UUID, 94 numeric.

---

## 8. Runtime track representation — structure of arrays

The performance core. Per map, all journeys concatenated into flat typed arrays, ordered by
journey and then by `tRel`.

```ts
interface MapTracks {
  mapId: MapId;
  journeyCount: number;
  pointCount: number;

  journeyIds: JourneyId[];              // index -> id
  offsets: Uint32Array;                 // length journeyCount + 1; slice [i], [i+1]

  // --- per point, all journeys concatenated ---
  worldX: Float32Array;                 // raw game-space, preserved
  worldZ: Float32Array;
  u: Float32Array;                      // normalized, derived once at load
  v: Float32Array;
  tRel: Uint16Array;                    // seconds since match start; max observed 890
  eventType: Uint8Array;                // pinned codes from §2
  journeyIndex: Uint32Array;            // point -> journey, for reverse lookup
}
```

**Memory:** 87,599 points × 23 bytes ≈ **2.0 MB** resident for the whole dataset; ~1.4 MB for
AmbroseValley alone. Negligible, and it is contiguous rather than 87,599 scattered objects.

`Uint16Array` for `tRel` is safe with room to spare: the longest match observed is **890 s**
against a ceiling of 65,535.

### Why this is the heatmap-friendly representation

A heatmap is: filter points → bin into a grid → blur → colourise. With SoA that inner loop is

```ts
for (let i = 0; i < n; i++) {
  if (!layerMask[eventType[i]]) continue;
  if (!journeyVisible[journeyIndex[i]]) continue;
  bins[(v[i] * rows | 0) * cols + (u[i] * cols | 0)]++;
}
```

— one contiguous pass, no pointer chasing, no allocation. Binning AmbroseValley's ~60k points
costs well under a millisecond, so heatmap radius and bin size can be live controls rather than
a re-fetch. Bins are therefore **computed client-side and never transmitted**, which also keeps
them consistent with whatever filter is active.

Three layers are defined over the same arrays by event-code mask:

| Layer | Event codes | Points |
|---|---|---:|
| Traffic (dwell) | `Position`, `BotPosition` | 72,849 |
| Kills | `Kill`, `BotKill` | 2,379 |
| Deaths | `Killed`, `BotKilled`, `KilledByStorm` | 739 |

Traffic is labelled **dwell** deliberately: sampling is uniform at ~5 s, so a count per bin is
time-in-area, not throughput.

---

## 9. Timeline model

```ts
interface TimelineModel {
  matchId: string;
  startedAt: number;                    // epoch seconds
  durationSec: number;                  // 0 .. durationSec is the scrub range

  /** Discrete events only — the ticks drawn on the scrubber track. */
  markers: { tRel: number; type: EventType; journeyId: JourneyId }[];

  /** Per journey, the window during which it has telemetry. */
  spans: { journeyId: JourneyId; startTRel: number; endTRel: number }[];
}
```

### Efficient playback

Playback advances monotonically, so the model supports an **O(1) amortised cursor per journey**
rather than a search per frame:

```ts
interface PlaybackCursor {
  journeyIndex: number;
  pointIndex: number;                   // last point with tRel <= currentT
}
```

Each frame advances `pointIndex` while `tRel[pointIndex + 1] <= currentT`. Across a whole match
that is one linear pass over the arrays, regardless of frame rate. Scrubbing backwards resets
the cursor and binary-searches the journey's slice — `tRel` is sorted within each slice, so that
is O(log n).

Two properties the timeline must respect, both measured:

- **Sampling is ~5 s** (modal exactly 5.0). Interpolating between samples is legitimate; drawing
  a smooth 60 fps curve implies precision that does not exist. The renderer interpolates
  linearly and the UI states the cadence.
- **Gaps reach 518 s** (p99 = 25 s). A gap must break the path, not be drawn as straight-line
  travel. The renderer compares consecutive `tRel` against a threshold; no extra field is stored.

---

## 10. Indexing strategy

Filtering must never scan 87,599 points. All filtering happens over the 1,242-entry journey
index, and only the surviving journey ids touch the track arrays.

**Prebuilt inverted indexes** (built once at load, from `index.json`):

```ts
interface JourneyIndex {
  byId: Map<JourneyId, JourneyModel>;
  byMap: Map<MapId, JourneyId[]>;            // 3 buckets: 836 / 295 / 111
  byDate: Map<string, JourneyId[]>;          // 6 buckets
  byMatch: Map<string, JourneyId[]>;         // 796 buckets
  byUser: Map<string, JourneyId[]>;          // 339 buckets
  byActorType: Map<ActorType, JourneyId[]>;  // 2 buckets: 798 / 444
  sortedByStart: JourneyId[];                // date/time ordered
}
```

A combined filter (map + date + actor) intersects the smallest bucket first. With 1,242 records
this is microseconds; the indexes exist for predictability rather than raw necessity.

**Point-level visibility** is a `Uint8Array(journeyCount)` mask, checked in the render loop via
`journeyIndex[i]`. Changing a filter rewrites a 1,242-byte mask — no re-derivation of point data.

**Selection resolution** (`journeyId` → points) is `offsets[i]`..`offsets[i+1]`, O(1).

---

## 11. Wire format and payload budget

### Encoding comparison — measured, whole dataset

| Encoding | Raw | gzip | **brotli** | Lossless |
|---|---:|---:|---:|---|
| JSON array-of-objects (naive) | 16,907 KB | 1,915 KB | **1,290 KB** | yes |
| JSON columnar, full float | 3,832 KB | 1,378 KB | **966 KB** | ~ |
| Parquet (zstd) | — | — | **1,042 KB** | yes |
| float32 binary, raw | 684 KB | 599 KB | **559 KB** | **yes** |
| float32 binary, byte-shuffled | 684 KB | 530 KB | **507 KB** | **yes** |
| **JSON columnar, int 2dp** | 1,641 KB | 570 KB | **431 KB** | no (±0.005) |
| JSON columnar, delta int 2dp | 1,267 KB | 436 KB | **376 KB** | no |
| JSON columnar, delta int 1dp | 1,110 KB | 343 KB | **295 KB** | no (±0.05) |

The naive form is **3× larger** than the chosen one — repeated `user_id`/`match_id`/`map_id`
strings are the entire difference.

### Split strategy — measured, decisive

| Strategy | Files | Total gzip | Median file | Largest file |
|---|---:|---:|---:|---:|
| Single bundle | 1 | 588.6 KB | 588.6 KB | 588.6 KB |
| **By map** | **3** | **592.0 KB** | 141.3 KB | 406.5 KB |
| By map + date | 16 | 604.0 KB | 19.6 KB | 159.1 KB |
| By match | **796** | **761.0 KB** | 0.8 KB | 8.1 KB |

**Splitting by match is rejected on measurement**, not taste: it costs **+29% total bytes** (per-
file compression cannot amortise a dictionary across 0.8 KB files) and **796 HTTP requests**. The
dataset is far too small to justify per-match granularity.

**Split by map** is the choice: it costs **0.6%** over a single bundle while letting the app fetch
only the map in view. A Level Designer works one map at a time, so the practical first load is
one map, not all three.

### Delivered artifacts

| Artifact | Contents | brotli |
|---|---|---:|
| `manifest.json` | build id, schema version, event dictionary, data-quality counters | ~2 KB |
| `maps.json` | 3 × `MapModel` | ~2 KB |
| `index.json` | 1,242 × `JourneyModel` + 796 × `MatchModel` | **33 KB** |
| `tracks/AmbroseValley.json` | 59,847 points | **295 KB** |
| `tracks/Lockdown.json` | 21,029 points | **105 KB** |
| `tracks/GrandRift.json` | 6,723 points | **34 KB** |
| `minimaps/{map}.webp` | 2048 px, quality 82 | **162–189 KB** |
| `minimaps/{map}_thumb.webp` | 256 px picker thumbnail | ~7 KB |

**Track file shape** (per map, journey ids dictionary-encoded to integers):

```json
{ "map": "AmbroseValley",
  "journeys": ["<uuid>|<match>.nakama-0", "..."],
  "tracks": [ { "i": 0,
                "t": [0, 5, 10, ...],
                "x": [-30145, -31780, ...],
                "z": [-35555, -35211, ...],
                "e": [7, 7, 6, ...] } ] }
```

### Expected first load

| | AmbroseValley | Lockdown | GrandRift |
|---|---:|---:|---:|
| manifest + maps + index | 37 KB | 37 KB | 37 KB |
| minimap WebP (2048) | 173 KB | 189 KB | 162 KB |
| track data | 295 KB | 105 KB | 34 KB |
| **Total (brotli)** | **~505 KB** | **~331 KB** | **~233 KB** |

Switching maps fetches one track file plus one image. All three maps fully loaded is **~1.07 MB**.

The minimaps are the real weight, not the telemetry: **23.3 MB of source artwork becomes 523 KB**
at 2048 px — a 98% reduction, and the single highest-value optimisation in the pipeline.

### Why no backend, no database

The **entire** dataset is ~433 KB compressed and 2.0 MB resident. It is static, historical, and
never mutates. A server or database would add deployment surface, latency and failure modes to
query something that fits comfortably in memory. The pipeline runs offline; the app is static
files on a CDN. This is a conclusion from the measurement, not a preference.

---

## 12. Coordinate precision — the one deliberate loss

Coordinates ship as **integer centi-units** (`round(x * 100)`), decoded to `Float32Array` at load.

**Error budget, measured against render size:**

| Rounding | Max error | At 2048 px render | At native 9000 px |
|---|---:|---:|---:|
| 0 dp | 0.5 units | 1.25 px | 5.0 px |
| 1 dp | 0.05 units | 0.125 px | 0.5 px |
| **2 dp** | **0.005 units** | **0.0125 px** | **0.05 px** |
| 3 dp | 0.0005 units | 0.0013 px | 0.005 px |

At 2 dp the worst-case error is **1/80th of a pixel** at our maximum render resolution — roughly
a thousand times finer than the ~5-second sampling interval already limits path fidelity to.

**This is a real, if tiny, deviation from bit-exact float32**, so it is stated plainly rather
than buried: the requirement to "preserve raw world coordinates" is met in the sense that
world-space coordinates are carried through the model and displayed to the user, not discarded
in favour of UV. Bit-exact float32 is available for **+76 KB** (507 KB vs 431 KB brotli) behind a
`--lossless` pipeline flag if the precision is ever wanted. Given that displayed values are
read to 2 dp anyway, storing seven significant digits of float32 mantissa serves nobody.

**Delta encoding was measured and declined.** It saves 55 KB (376 vs 431 KB) but adds a
prefix-sum decode and complicates random access, for a 13% cut of an already-small payload. Not
worth the complexity now; recorded here as a lever if the dataset grows an order of magnitude.

---

## 13. Tradeoffs

| Decision | Alternative | Why | Cost |
|---|---|---|---|
| Split by **map** | Single bundle | Fetch only the map in view | +0.6% total bytes |
| Split by **map** | Split by match (796 files) | Rejected on measurement | would be +29% bytes, 796 requests |
| **Columnar** JSON | Array of objects | Removes repeated ids | 3× smaller |
| **JSON** | Binary typed arrays | Debuggable, no custom parser; brotli beats raw float32 anyway | −76 KB vs lossless binary |
| **int 2dp** coordinates | float32 lossless | 1/80 px error, invisible | +76 KB to go lossless |
| **Absolute** integers | Delta encoded | Simpler, random-access friendly | +55 KB |
| **Derive** `uv` at load | Transmit `uv` | Exact affine function of world coords | ~180 KB saved |
| **Client-side** heatmap bins | Precomputed bins | Live radius/bin controls, respects active filters | ~0.5 ms per rebin |
| **Static files** | API + database | Whole dataset is 433 KB | none |
| **SoA** typed arrays | Object graph | Contiguous, allocation-free hot loops | slightly more code |
| **Journey**-level actor type | Player-level | `user_id 1429` is both | none |
| Keep `sourceFolder` | Drop it | Folder misfiles 436 rows; provenance is auditable | ~10 KB |
| **2048 px** minimaps | 3072 px / native | 98% smaller, above display density | −303 KB vs 3072 |

---

## 14. What this model deliberately does not do

- **No `extracted` or `survived` field.** No extraction event exists in the telemetry. Absence of
  a death is equally consistent with extraction, truncation or disconnect. Inventing the field
  would manufacture a metric the data cannot support.
- **No inferred killer/victim linkage.** The 3 `Kill`/`Killed` pairs share one actor, position
  and timestamp; their meaning is undetermined. No relationship is fabricated.
- **No storm-front reconstruction.** The README describes a one-directional storm, but only 39
  `KilledByStorm` events exist and no storm-state telemetry. Nothing is modelled.
- **No clamped coordinates.** Validated at 100% in-bounds; out-of-range would be a signal worth
  surfacing, not hiding.
- **No `isPartialRoster` guesswork.** It reports journey count, and does not estimate the true
  roster size, which is unknowable.

---

## 15. Contract stability

`manifest.json` carries `schemaVersion`, the pinned event dictionary, the pipeline build id, and
the data-quality counters (rows in/out, duplicates removed, actor conflicts). The frontend
asserts `schemaVersion` on boot and refuses to render against an unexpected version, so a
pipeline change cannot silently produce a wrong picture.
