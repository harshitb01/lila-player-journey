# LILA Player Journey — Handoff Report

Audit date: 2026-08-26  
Audited revision: `b1fdd71cee2013fbd546fa800bc24195268330ba` (`master`, matching `origin/master`)  
Scope: repository documentation, application source, scripts, tests, raw/processed data contracts, generated artifacts, screenshots, and Git state.

## Audit basis and verification

This report describes the checked-in implementation, not the intended design in isolation. Claims in `README.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `UX_SPEC.md`, and `INSIGHTS.md` were checked against the code and generated data.

No original assignment/brief file is present in the repository or its two-commit history. `UX_SPEC.md` says the assignment asks four questions—where players move, where fights happen, where storm deaths occur, and which areas are ignored—so those are used as the best available proxy. The `player_data/README.md` referenced by the original README is also absent. Any requirement conclusion below should be reconciled against the actual take-home brief before submission.

Verification performed during this audit:

- `npm test -- --run`: 10 test files and 195 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed; Vite produced a 256.29 KB JavaScript bundle (79.36 KB gzip) and 24.60 KB CSS bundle (5.40 KB gzip).
- A full `scripts/build_data.py` run read all 1,243 Parquet files, passed 18/18 pipeline checks, and generated 12 files byte-for-byte identical to `public/data`, including the declared content hash `02cf2703a099f732ab16167b6764a2bf7224809822865f254f911600ef0c5b40`.
- An independent pass over the shipped JSON confirmed 1,242 aligned tracks, 87,599 points, no invalid journey references, no unknown event codes, and monotonic per-track timestamps.
- `scripts/analyze_insights.py` was run and compared with `INSIGHTS.md`.
- Git was clean at the audited revision before this report was added. This report is the only intended working-tree addition.

## 1. What is currently implemented

The project is a static, client-side React 19/TypeScript/Vite analytics application for visualizing LILA BLACK player telemetry on three minimaps. There is no backend or runtime data processing service.

Implemented application capabilities:

- Map selection for Ambrose Valley, Grand Rift, and Lockdown.
- Date, human/bot, and match filters with derived facet counts.
- Canvas rendering of minimaps, player routes, selected-route endpoints, sparse points, event markers, current playback positions, heatmaps, and shift-drag regions.
- Event visibility controls for movement, loot, kills, non-storm deaths, and storm deaths.
- Journey selection from a list when the cohort is small, or by clicking near a sampled route point.
- Journey inspector with identity/provenance, duration, sample count, event counts, start/end coordinates, and a lower-bound travel-distance estimate.
- Match playback with play/pause, seeking, restart, and 0.5x/1x/2x/4x speed controls.
- Traffic, kill, and death heatmap modes.
- Region statistics for traffic, kills, deaths, storm deaths, and distinct human/bot journeys.
- A data-quality modal backed by warnings emitted into `manifest.json`.
- Lazy loading of the selected map's track payload.
- Client-side empty, loading, data-error, minimap-error, and track-error states.
- Static hosting configuration through `vercel.json` and a relative Vite base path.

Implemented data tooling:

- Raw Parquet discovery and schema validation.
- Exact duplicate-file and duplicate-row removal.
- Timestamp normalization and UTC date derivation.
- Human/bot classification based primarily on movement-event vocabulary.
- Match and journey reconstruction.
- World-to-minimap projection and bounds validation.
- Minimap resizing/WebP generation.
- Columnar JSON emission and post-build integrity checks.
- Forensic dataset analysis, coordinate validation/fixture generation, and descriptive insight analysis scripts.

The shipped dataset contains:

| Item | Count |
| --- | ---: |
| Raw files | 1,243 |
| Raw rows | 89,104 |
| Removed duplicate-file rows | 88 |
| Removed exact duplicate rows | 1,417 |
| Processed rows/points | 87,599 |
| Journeys | 1,242 (798 human, 444 bot) |
| Matches | 796 |
| Distinct players | 339 |
| UTC dates | 6 (`2026-02-09` through `2026-02-14`) |

## 2. What is partially implemented

- **Playback:** functional and deterministic for a given timestamp, but positions jump between recorded samples. There is no interpolation, event stepping, keyboard stepping, or follow-player mode.
- **Heatmaps:** traffic, kills, and deaths work, but loot, ignored/unvisited-area highlighting, radius control, numerical bin inspection, and an absolute scale are absent.
- **Region inspection:** counts and cohort composition work, but the region cannot reveal or select the contributing journeys/matches. It is a summary, not the drilldown described in `UX_SPEC.md`.
- **Route selection:** the selected journey can be clicked, but hit testing measures distance to recorded points only, not to line segments. A visible route between sparse samples may be difficult or impossible to select.
- **Match exploration:** the selector is capped at the newest 300 matches. Ambrose Valley has 566 matches, so older matches cannot be selected from the default unfiltered list. Options show time but not date when several dates are active.
- **Data quality:** the pipeline records aggregate warnings and deduplication totals, but the UI cannot switch between raw and deduplicated metrics or inspect structured per-event raw/dedup counts as some documentation claims.
- **Runtime schema safety:** the loader checks the manifest schema version and the event mappings that are present, but it does not comprehensively validate index schema/version, required event-code completeness, column lengths, dictionary ranges, per-track array alignment, map identity, or content hash.
- **Coordinate parity protection:** tests cover the current formula and a 600-vector fixture, but duplicated configuration sources can still drift independently.
- **Accessibility/responsiveness:** basic labels and buttons exist, but the map interactions lack keyboard equivalents, the modal lacks focus management, and the fixed desktop layout has no narrow-screen notice or usable small-screen fallback.
- **Insight reproducibility:** the analysis script reproduces the headline descriptive tables, but not all robustness checks claimed by `INSIGHTS.md`.

## 3. What is missing

- The original assignment brief and referenced source-data README.
- A first-class answer to the stated “ignored areas” question in the product UI.
- Loot heatmap and unvisited/low-activity overlay.
- Heatmap radius/smoothing control and numerical heatmap-bin tooltip.
- Path visibility control; all cohort paths are currently drawn even when the UI stops listing journeys.
- Region-to-journey/match drilldown.
- Match search or complete match pagination.
- Follow-player playback, linear interpolation, previous/next-event controls, clickable timeline ticks, and keyboard stepping.
- Path-sample and heatmap-bin tooltips.
- A numerical legend for density/dwell or event count.
- Retention of the source `y` coordinate in processed frontend data. Only `x` and `z` are emitted.
- Component, reducer/store, loader, integration, end-to-end, visual-regression, accessibility, and Python pipeline tests.
- A pinned Python dependency manifest such as `requirements.txt` or `pyproject.toml`.
- A deployed/live-demo URL; the README still treats deployment as pending.

## 4. Current architecture

The runtime is a build-time data pipeline plus a static single-page application:

```text
data/raw/**/*.parquet
        |
        v
scripts/build_data.py
        |
        +--> public/data/manifest.json
        +--> public/data/maps.json
        +--> public/data/index.json
        +--> public/data/tracks/<map>.json
        +--> public/data/minimaps/*.webp
                         |
                         v
src/data/loader.ts --> React reducer/context --> filter selection
                                                |
                                                v
                                      Canvas renderer + DOM controls
```

Important boundaries:

- `src/data/types.ts`, `model.ts`, and `loader.ts` define the wire/runtime data boundary and convert columnar JSON to objects and typed arrays.
- `src/state/store.tsx` owns dataset loading, lazy map-track loading, filter state, playback state, focus, and region selection through `useReducer` plus effects.
- `src/state/filtering.ts` derives visible journeys, event totals, facet counts, and compact slot masks.
- `src/render/*` contains coordinate-independent canvas rendering, viewport fitting, event glyphs, heatmap computation, playback slicing, region math, and hit testing.
- `src/components/*` contains the DOM controls, inspectors, timeline, error/loading states, and the canvas host.
- `src/App.tsx` assembles a fixed desktop layout with a header, 260 px left rail, central canvas, optional 300 px journey inspector, and bottom timeline.

The architecture is appropriately simple for the current data volume: no server, database, routing library, charting library, or global-state dependency. The main concern is documentation drift. `DATA_MODEL.md` describes a richer aspirational model with entities and indexes that do not exist in the code; it should not be treated as an exact specification of the implementation.

## 5. Current data pipeline

`scripts/build_data.py` performs nine stages:

1. Recursively discovers raw telemetry files.
2. Reads Parquet, enforces one eight-column schema, and decodes event bytes.
3. Removes one byte-identical duplicate file and then exact duplicate rows across all eight columns.
4. Interprets timestamps as epoch seconds, derives UTC date and match-relative seconds, and preserves source folder as provenance.
5. Classifies actors. Movement vocabulary wins over identifier shape, which resolves 17 conflicting rows from numeric human IDs.
6. Reconstructs 796 matches and 1,242 journeys; 743 matches are partial single-journey rosters and three journeys have only one movement sample.
7. Projects all points and rejects out-of-bounds results.
8. Emits frontend JSON and minimap WebP files.
9. Runs 18 reconciliation, reference, range, and round-trip checks, then computes a content hash.

Actual processed format:

- `manifest.json`: schema version, content hash, event-code mapping, coordinate quantization scale, dataset totals, and data-quality warnings.
- `maps.json`: map metadata, projection metadata, image dimensions/URLs, observed world/UV bounds, and totals.
- `index.json`: dictionaries plus columnar match and journey tables. Match-to-journey relationships are reconstructed by the loader.
- `tracks/<map>.json`: `{ map, tracks }`, where each track is `{ j, t, x, z, e }`. `j` is the global journey index; `t` is integer match-relative seconds; `x`/`z` are world coordinates quantized at 100 units per world unit; `e` is an event code.
- `minimaps/*.webp`: full and thumbnail images.

The full audit rebuild produced exactly the checked-in 12 artifacts. This is strong evidence that the current raw corpus, script, and shipped outputs agree.

Pipeline risks:

- Python dependencies are documented only as ad-hoc `pip install pandas pyarrow Pillow` instructions. The local `.venv` launcher points to a missing Python installation; the audit had to use another Python 3.12 executable with the venv's site-packages.
- The output directory is deleted recursively before a build. `--out` is user-controlled and is not guarded against the repository root or another unsafe path.
- `--skip-images` creates metadata without generated images; it is useful for verification but is not a complete deploy artifact.
- The processed contract drops raw `y`; `DATA_MODEL.md`'s statement that raw world coordinates are preserved is therefore only true for `x` and `z`.

## 6. Coordinate mapping implementation

The frontend uses a linear XZ-to-UV transform:

```text
u = (x - originX) / scale
v = (z - originZ) / scale
pixelX = left + u * fittedWidth
pixelY = top + (1 - v) * fittedHeight
```

Current hard-coded projection constants are:

| Map | Scale | Origin X | Origin Z |
| --- | ---: | ---: | ---: |
| Ambrose Valley | 900 | -370 | -473 |
| Grand Rift | 581 | -290 | -290 |
| Lockdown | 1000 | -500 | -500 |

`viewport.ts` fits the natural minimap aspect ratio inside the canvas with padding. Grand Rift's delivered image remains slightly non-square (2048×2046), so independent fitted width/height are important. Coordinates are intentionally not clamped during normal projection; invalid data should remain detectable. Region-drag UV coordinates are clamped to the map.

Evidence for current correctness is good:

- The raw-data build projected all 87,599 points in bounds.
- The build's coordinate round-trip check passed with maximum error 0.005017 world units.
- Unit tests cover formula, round-trip, boundaries, pixel Y inversion, map constants, off-map behavior, and viewport aspect fitting.
- A 600-vector parity fixture exercises the Python validation constants against TypeScript.

The drift protection is weaker than `ARCHITECTURE.md` implies. Projection constants exist independently in `build_data.py`, `coordinate_validation.py`, `coordinates.ts`, and emitted `maps.json`. The parity fixture comes from `coordinate_validation.py`, not from `build_data.py`. The loader ignores the projection in `maps.json` and uses the TypeScript constants, while track decoding defaults to a hard-coded quantization scale of 100 instead of consuming `manifest.coordinateScale`. A future change can therefore pass one set of checks while runtime rendering uses another set of constants.

## 7. Playback implementation

Playback is enabled only after a match is selected. Match-relative time is stored in reducer state. A `requestAnimationFrame` loop advances elapsed real time by the selected speed, clamps at match duration, draws directly to canvas each frame, and publishes React state at roughly 10 Hz to avoid rendering the component tree at 60 Hz.

For every visible journey in the selected match, `playback.ts` uses binary search to find the inclusive end index at the current whole-second time. Rendering shows the recorded path prefix and places the current marker at the latest recorded sample. Seeking or jumping directly to a timestamp gives the same slice as playing to it, because the result is derived from time rather than an accumulated cursor.

Limitations and inconsistencies:

- There is no interpolation. “Current position” is stepwise, despite `UX_SPEC.md` requiring linear interpolation.
- There is no follow-player mode, event stepping, arrow-key stepping, or clickable event ticks.
- Timeline ticks are built from all journeys in the match and event visibility, but do not honor human/bot cohort visibility. A hidden actor's event can remain on the timeline while absent from the map.
- The determinism test is weaker than its name: its forward-progress assertion allows a range instead of requiring the exact same final slice. The pure implementation is deterministic, but that particular test does not prove the full claim.
- The binary search avoids scanning for the cutoff, but the renderer then scans and allocates the elapsed movement indices for each journey—twice per frame in playback, once for paths and once for current positions.

## 8. Heatmap implementation

Heatmaps are computed from the currently visible journey slots on the active map. The implementation:

- Bins qualifying points into a fixed 160×160 `Float32Array` grid.
- Supports traffic (`Position` + `BotPosition`), kills (`Kill` + `BotKill`), and deaths (`Killed` + `BotKilled` + `KilledByStorm`).
- Applies two passes of separable box blur with the configured radius.
- Caps color intensity at a percentile to prevent one hotspot from flattening the rest of the map.
- Converts the grid to an RGBA offscreen canvas and stretches it over the fitted minimap.
- Memoizes binning/blur separately from recoloring and does not recompute heatmaps as playback advances.

This is a reasonable relative-density visualization at the current scale, and unit tests cover binning, filtering, blur, percentile caps, and empty data.

Important limitations:

- No loot mode, ignored/unvisited mode, smoothing/radius control, dwell-time normalization, absolute scale, or bin tooltip.
- Heatmaps represent recorded sample density, not unique journeys or rigorously normalized time spent. The legend's “time spent” phrasing is stronger than the underlying metric.
- If future malformed data reaches runtime, out-of-bounds UVs are clamped into edge bins instead of rejected. The current pipeline prevents this for the shipped data.
- All route paths remain overlaid, which can obscure the aggregate heatmap on the large Ambrose cohort.

## 9. Known bugs or risks

| Severity | Issue | Evidence and impact |
| --- | --- | --- |
| High | Track-load Retry does not retry | The button dispatches `map/select` with the already-selected map. The reducer returns the same state, so the loading effect's dependencies do not change. A transient track request failure leaves the map unrecoverable without selecting another map/reloading. |
| High | Old minimap can appear under new-map data/loading | `useMinimapImage` does not clear its image ref when the map URL changes. Until the new image loads, a redraw can use the previous map image with the newly selected map viewport/data. |
| High | `INSIGHTS.md` overstates reproducibility | It says all figures/robustness checks come from `analyze_insights.py`, but the script does not compute the documented map-split checks, match-length terciles, single-vs-multi checks, final-event check, alternate bot classification, longest-bot examples, distinct-journey contribution, first-15-second exclusion, or journey-relative late-visit shares. The script also silently excludes one kill and one loot event from quartile tables (printed bins sum to 2,378/2,379 kills and 11,631/11,632 loot events). |
| Medium | Async map-load state is not keyed safely | A late request for a previous map can clear the single `tracksLoading` flag or set a global `tracksError` while another map is active, producing misleading state and retry behavior. |
| Medium | Runtime payload validation is incomplete | The loader trusts most JSON casts and does not verify the shipped content hash. Missing event codes, dictionary/order drift, malformed column lengths, and bad track arrays may fail silently or corrupt rendering. |
| Medium | Match selector hides valid data | The newest-300 cap makes 266 Ambrose matches inaccessible in the all-date default cohort. Time-only option labels are ambiguous across six dates. |
| Medium | Large-cohort path behavior contradicts the design | `pathsReadable` changes opacity/listing/endpoints but does not disable paths. The app still constructs and draws every route when hundreds are visible, contrary to the path-off/auto-enable behavior described in `UX_SPEC.md`. |
| Medium | Region workflow stops before investigation | A region reports aggregate counts but cannot list or select the journeys and matches behind them, so the documented region → match → playback workflow is not possible. |
| Medium | Coordinate configuration can drift | Four independent config sources exist; runtime ignores emitted projection metadata and manifest quantization scale. Current data is correct, but future regeneration can become inconsistent without a single authoritative contract. |
| Low/Medium | Date checkbox semantics are misleading | An empty set means “all dates,” so every checkbox appears checked. Clicking one apparently checked date narrows to only that date instead of unchecking it. |
| Low/Medium | Route hit testing misses line segments | Selection checks sample points only, so sparse, long visible segments have no corresponding selectable area. |
| Low | Single-sample journeys may disappear in aggregates | The renderer only draws sparse points below its cohort threshold. The three one-sample journeys are not represented as paths and may be invisible until narrowed/selected, despite the data-quality text saying they are shown as points. |
| Low | UI messages can overstate evidence | The empty PvP message can say all combat is versus bots even when there is no combat in the current selection. Hover tooltip state can also remain stale after filters/layers change until the pointer moves. |
| Operational | Pipeline output deletion is insufficiently guarded | `build_data.py` recursively removes the supplied output path. A mistaken `--out` value can delete unrelated files. |

## 10. Performance concerns

Current payload size and lazy loading are sensible. The shipped data is about 2.23 MB uncompressed across 12 files, and map tracks are fetched only when selected. Typed arrays, batched event `Path2D`s, cached static rendering, capped device-pixel ratio, offscreen heatmap rendering, and throttled React playback updates are all appropriate choices.

The main hot path does more work than the architecture document claims:

- Binary search finds each playback cutoff in logarithmic time, but `movementIndices` then linearly scans all elapsed points and allocates a JavaScript array.
- Route drawing rebuilds cohort `Path2D`s each playback frame, even for long paths already seen in previous frames.
- Current-position rendering calls `movementIndices` again, duplicating the per-journey scan/allocation.
- Event rendering scans all points on the active map on every playback frame.
- Pointer move/click hit testing scans all active map points or journeys; there is no spatial index.
- Filter changes scan all journeys for the active map and recreate sets/masks. Focus changes also trigger selection rebuilding even when cohort membership is unchanged.
- All paths are rendered for the 836-journey Ambrose default view.

The dataset is still small enough that the build and screenshots look viable, but there are no runtime frame-time, interaction-latency, or memory benchmarks. Performance claims should be considered unproven until tested on a representative laptop during full Ambrose playback and pointer interaction.

## 11. Assignment requirements not yet satisfied

Because the official brief is unavailable, this section distinguishes the four quoted assignment questions from the additional internal `UX_SPEC.md` acceptance criteria.

| Requirement inferred from repository | Status |
| --- | --- |
| Show where players move/spend time | Substantially satisfied through routes and traffic heatmap, with the caveat that density is sample count rather than normalized dwell time. |
| Show where fights happen | Substantially satisfied through kill markers and kill heatmap. The data is overwhelmingly bot combat; only three `Kill` events are human-vs-human. |
| Show where storm deaths occur | Satisfied through distinct storm glyphs and the combined deaths heatmap; there is no storm-only heatmap. |
| Identify ignored areas | Not satisfied in the UI. The script reports empty grid cells within the observed envelope, but the product has no unvisited/ignored overlay and cannot distinguish unvisited from unplayable space. |
| Aggregate-first default with paths off | Not satisfied: paths are always rendered. |
| Traffic/Kills/Deaths/Loot/None heatmap layers | Partially satisfied: Loot is missing. |
| Heatmap radius and highlight-unvisited controls | Missing. |
| Region → journeys/matches → playback | Not satisfied: region drilldown is missing. |
| Linear playback interpolation and player follow | Missing. |
| Previous/next event, keyboard steps, clickable event ticks | Missing. |
| Heatmap-bin/path tooltips and numerical legend | Missing. |
| Desktop notice below 1100 px | Missing. |
| Reproducible evidence for submitted insights | Partially satisfied; several documented checks are not implemented by the cited script. |
| Hosted demo | Apparently missing/pending based on the README. |

The most serious acceptance risk is the fourth core question: the repository explicitly identifies ignored-area analysis as an assignment requirement, but that capability exists only as console analysis, not as an interactive product feature.

## 12. Recommended next steps ranked by priority

1. **Obtain the actual assignment brief and source-data README.** Turn it into a short acceptance checklist before changing code. This prevents polishing internal design ideas while missing an official deliverable.
2. **Fix correctness/recovery defects first.** Add a real track-retry action, key loading/error state by map/request, cancel or ignore stale responses, and clear the old minimap immediately on map change.
3. **Make the insight report honestly reproducible.** Either implement every robustness calculation claimed in `INSIGHTS.md` (including explicit handling of zero-duration matches) or remove/qualify unsupported claims. Add output snapshots or tests for the headline numbers.
4. **Complete the stated core analysis question.** Implement an ignored/low-activity overlay with an explicit playable/observed-envelope caveat, plus loot heatmap and useful legend/tooltips.
5. **Complete the investigation workflow.** Make region results list contributing journeys/matches, remove the 300-match blind spot, add date-aware match labels/search, and connect results to playback.
6. **Align playback behavior with the selected requirements.** Decide explicitly whether stepwise samples are acceptable. If not, add linear interpolation, actor-filter-consistent ticks, clickable/keyboard event navigation, and follow-player mode.
7. **Reduce render hot-path work before adding more layers.** Cache static path geometry, avoid duplicate movement-index scans/allocations, disable or aggregate paths for large cohorts, and add a simple spatial index for hit testing. Measure Ambrose frame time before and after.
8. **Strengthen contract validation and remove coordinate duplication.** Validate schema version/content hash/column lengths/track arrays at runtime, consume manifest scale and emitted projection metadata, and generate TypeScript parity fixtures from the actual pipeline authority.
9. **Add missing test layers.** Prioritize loader/reducer retry and stale-request tests, component interaction tests, one browser-level map/filter/region/playback flow, pipeline regression tests, and a visual check for map-switch correctness.
10. **Harden pipeline reproducibility.** Add pinned Python dependencies, guard destructive output paths, document the supported Python command, and run the data build in CI to compare the generated content hash.
11. **Reconcile documentation with reality.** Mark `DATA_MODEL.md` and `UX_SPEC.md` clearly as design documents or update them to the actual model. Remove stale renderer comments and claims such as “all figures computed by this script” unless they become true.
12. **Finish submission polish last.** Verify deployment, add the live URL, test the fixed layout on the target desktop sizes, add the narrow-screen notice/accessibility basics, and refresh screenshots only after behavior is final.

No application code was changed during this audit.
