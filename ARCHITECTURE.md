# Architecture

## Stack

React 19 + TypeScript + Vite, Tailwind, HTML Canvas 2D for rendering, `useReducer` +
Context for state (no Redux/Zustand — state is one dataset, a few filters, and a track
cache; nothing here needs a library). Python 3 (pandas/pyarrow) is an **offline build
tool only** — it never runs in the browser or on a server. Vitest: 204 tests, 11 files.
No backend, no database.

## Data flow

```
data/raw/*.nakama-0 (Parquet)
   │  scripts/build_data.py  — one-shot, build-time, deterministic
   ▼
public/data/{manifest,maps,index}.json + tracks/{Map}.json + minimaps/*.webp
   │  fetched by the browser (src/data/loader.ts)
   ▼
Dataset → useReducer store → filtered (src/state/filtering.ts) → typed-array MapTracks
   ▼
Canvas (src/render/renderer.ts) via MapCanvas.tsx
```

## Preprocessing — why build-time ETL

`scripts/build_data.py` runs nine stages (discover → validate schema → deduplicate →
normalise timestamps → classify actors → reconstruct matches → project → emit → verify,
18 automated checks) as a **developer command** (`npm run data`), not a per-request
step. Parquet parsing needs pyarrow, which doesn't run in a browser; doing it offline
also makes the output deterministic, hashable, and testable in isolation, and the build
fails loudly on schema drift rather than silently shipping bad data. Row reconciliation:
89,104 source rows → −88 (one file shipped twice) → −1,417 (exact duplicates, 87% Loot)
→ **87,599 processed rows**, 1,242 journeys, 796 matches, 3 maps.

## Normalized data

The frontend never sees the Parquet schema. `index.json` is columnar and
dictionary-encoded (parallel arrays, not 1,242 repeated objects), decoding to ~130 KB.
Per-map `tracks/{Map}.json` holds each journey's `(t, x, z, event)` arrays, decoded
client-side into typed arrays (`Float32Array`/`Uint16Array`/`Uint8Array`) rather than
one object per point — 87,599 rows scanned on every filter change needs to stay cheap.

## Coordinate transformation — and how it was validated

`map-config.json` is the authoritative projection contract. Both Python tools and
TypeScript load it; the pipeline emits the active projection into `maps.json`, and the
runtime uses that emitted projection plus `manifest.coordinateScale` when decoding
tracks. `worldToUv`/`uvToPixel` implement `u=(x-originX)/scale`. Two validation passes:
(1) offline —
rendered all 89,104 real points over each minimap, confirmed 100% land inside [0,1] UV,
checked orientation against the README's worked example (`COORDINATE_VALIDATION.md`);
(2) **cross-language parity test** — `scripts/coordinate_validation.py` samples 600 real
points, runs the Python projection, writes a fixture; `coordinates.parity.test.ts`
asserts the TypeScript projection matches to floating-point tolerance. This exists
because the formula implementations could silently drift while both test suites still
pass individually. Projection constants themselves are no longer duplicated.

## Human/bot detection

Classified by **movement vocabulary** (`BotPosition` present ⇒ bot), not the README's
UUID-vs-numeric-id rule. Vocabulary is a verified total, mutually exclusive partition
(0 of 1,242 journeys have both markers or neither); the id rule disagrees on 17
journeys. Both labels are retained per journey — nothing is discarded.

## Timeline / playback

Pure and stateless: at time `t`, a journey's visible slice cutoff is found by **binary
search** on its pre-sorted `tRel` array. Rendering still walks the visible prefix to
construct route geometry. The only `requestAnimationFrame`
loop in the app is the playback clock; it writes time into a ref and calls the draw
function directly, publishing to React at ~10 Hz rather than 60 Hz, so scrubbing never
re-triggers the filter/selection memoization.

## Canvas rendering — why Canvas

The scene is tens of thousands of points (up to 59,847 on Ambrose Valley) redrawn on
filter changes and 60fps playback — SVG/DOM would mean that many live nodes. In Auto
mode, cohort routes are hidden above 25 visible journeys so heatmaps and events remain
legible; users can explicitly Show/Hide them, and a selected route stays visible. When
drawn, each actor cohort batches into one `Path2D`. Humans and bots differ by **line
dash and weight**, not color alone.

## Heatmap strategy

A plain 160×160 grid in UV space, box-blurred (2 passes), rendered to an offscreen
canvas and scaled up. Point-count layers cover recorded movement samples, kills, deaths,
and loot. Low Activity inverses smoothed movement density only inside the map's observed
telemetry envelope; it deliberately does not treat zero telemetry as player avoidance or
evidence that terrain is playable. Layers rebuild only on filter/mode change, **never** on
`playback.time`.

## Why match-level (per-map) data loading

Tracks are fetched **per map**, lazily, on map selection — not per-match, not all three
maps upfront. A match isn't a separate resource; its journeys already live in its map's
file, so selecting a match is a client-side filter, not a new request. Three cacheable
requests total, versus one oversized bundle or hundreds of tiny per-match ones. Each
request carries a monotonically increasing id: late results may populate their keyed
cache entry but cannot clear or replace another map's active loading/error state.

## Why no backend or database

The full processed dataset is 2.3 MB. Every filter is a linear scan over ≤87,599 rows —
sub-millisecond. No query pattern here a database would serve better than static JSON
filtered in memory; a backend would add deployment surface to solve a problem this data
volume doesn't have.

## Why killer-victim relationships are not visualized

The schema records only the acting player's id and position for
`Kill`/`Killed`/`BotKill`/`BotKilled` — no target id exists. No line is drawn between two
actors, and no proximity heuristic guesses one, because that would fabricate a
relationship the data doesn't support. (Audited: `BotKill`/`BotKilled` counts on the same
match don't even reconcile 1:1, confirming these are independently logged, not two views
of one event.) Tooltips and the legend state this explicitly.

## Assumptions & limitations

`ts` is Unix epoch **seconds** despite the Parquet field declaring milliseconds (four
independent checks confirm it). Exact-duplicate rows are dropped globally, not per event
type. 93% of matches have exactly one captured journey — no full roster exists for most
matches. Recorded PvP is 3 events dataset-wide; adversarial review found this likely
*undercounts* true co-presence (all 3 real `Kill` events occur in matches recorded with
only one human) rather than proving PvP was rare — an export limitation, not a game fact.
Grand Rift has an order of magnitude less data than Ambrose Valley; anything computed on
it carries a wider error bar. Deployment is a static build (`dist/`) — no server is
required at runtime, and it is host-agnostic (any static/CDN host).

## Tradeoffs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Backend | None — static files | REST/GraphQL + DB | 2.3 MB dataset; DB adds ops cost for no query benefit |
| Rendering | Canvas 2D | SVG / DOM markers | 10⁴–10⁵ points at 60fps; DOM node count would dominate |
| ETL timing | Build-time, offline | Runtime parsing | No pyarrow in-browser; deterministic, testable output |
| Data loading | Per-map, lazy | All maps upfront / per-match | 3 cacheable requests vs. one bundle or hundreds of tiny ones |
| Actor classification | Movement vocabulary | README's id rule | Vocabulary is a verified 100% partition; id rule has 17 exceptions |
| Heatmap | Hand-rolled UV grid | Third-party heatmap lib | Same coordinate space as rendering; nothing to keep in sync |
| Combat visualization | Points only, no links | Proximity-inferred lines | No target id in schema — a link would be invented |
