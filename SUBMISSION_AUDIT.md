# Final submission audit

Audited 2026-08-26 against the requirements that can be established from this
repository. The original LILA Games take-home brief is not present in the working tree
or its available Git history, so its exact wording cannot be independently checked.
The four assignment questions quoted in `UX_SPEC.md` and the explicit requested feature
set are the audit baseline.

Status meanings: **Pass** is implemented and verified; **Blocked** needs an external
action; **Qualified** is implemented but has a material data or environment caveat.

| Requirement | Status | Evidence | Potential issue |
| --- | --- | --- | --- |
| Parse supplied Parquet telemetry | Pass | `scripts/build_data.py` uses `pyarrow.parquet.ParquetFile`, validates the exact eight-column Arrow schema, then decodes strict UTF-8 event bytes. The committed manifest reconciles 89,104 input rows to 87,599 processed rows. | The original source-data README is absent, so its intended schema cannot be compared word-for-word. |
| Render the correct minimap | Pass | `map-config.json` maps each map ID to its source artwork; the pipeline emits WebP paths in `public/data/maps.json`; `MapCanvas` keys minimap state by map. Ambrose Valley, Grand Rift, and Lockdown loaded in the running app; Grand Rift was visually inspected. | Artwork correctness is contingent on the supplied source images being the intended maps. |
| Map world coordinates correctly | Pass | The one authoritative projection contract is `map-config.json`, shared by Python and TypeScript. `coordinate_validation.py` checks all 89,104 raw points and a 600-point cross-language fixture; its documented result is 100% in bounds. | Bounds/orientation validate the supplied coordinate convention; they cannot prove a different undocumented game-world convention. |
| Distinguish humans and bots | Pass | Pipeline classification uses movement vocabulary (`Position`/`BotPosition`); UI exposes independent Humans/Bots toggles and solid/dashed routes. | 17 journeys conflict with the ID-format heuristic; the documented movement-vocabulary rule deliberately wins. |
| Show kill events | Pass | `Kill` and `BotKill` have separate marker shapes, a Kills toggle, tooltips, timeline ticks, and a Kill zones heatmap. | Events have no target ID, so killer-victim links are correctly not inferred. |
| Show non-storm death events | Pass | `Killed` and `BotKilled` have distinct triangle/diamond markers, a Deaths toggle, timeline ticks, and a Death zones heatmap. | Same no-counterparty limitation as kills. |
| Show loot | Pass | `Loot` has its own marker, event toggle, tooltip, timeline tick, and Loot pickups heatmap. | Loot markers are disabled by default because their volume can obscure other events. |
| Show storm deaths | Pass | `KilledByStorm` has a hexagon marker, Storm deaths toggle, tooltip, timeline tick, and region-stat category. | The dataset has only 39 storm-death records, so fine-grained spatial conclusions are weak. |
| Filter by map | Pass | Header map tabs update selection and lazy-load per-map tracks. All three maps were switched in the running app with no console warnings/errors. | Selection is map-scoped; choosing a new map intentionally clears match playback. |
| Filter by date | Pass | Multi-select dates are implemented in `Header.tsx` and tested interactively: the Grand Rift selection changed from 111 journeys (all dates) to 28 (2026-02-10) and was restored. | Empty date selection means “all dates”; that convention is documented by the control label. |
| Filter/select by match | Pass | Match search and all map matches are rendered in `LeftRail.tsx`; selection is a reducer action and is filter-reconciled. A visible match was selected during the browser check. | Lists are map-scoped by design, not a global cross-map match list. |
| Timeline | Pass | `Timeline.tsx` renders a duration-aware seek control and event ticks for the selected match. | Aggregate timeline is intentionally unavailable because a shared six-day playhead would be meaningless. |
| Playback | Pass | Play/pause/reset/seek and 0.5×–4× speeds are implemented. Browser check advanced the selected match seek value from 0 to 1 and exposed Pause. | Positions are discrete telemetry samples; the UI explicitly does not imply interpolation. |
| Traffic heatmap | Pass | `buildGrid(..., 'traffic')` uses `Position` and `BotPosition`; UI labels it “Movement samples,” not literal dwell time. | Sample density depends on telemetry sampling behavior. |
| Kill heatmap | Pass | The Kill zones heatmap uses `Kill` and `BotKill` point density. | It describes recorded event density, not combat duration or unique encounters. |
| Death heatmap | Pass | The Death zones heatmap uses `Killed` and `BotKilled` point density. | It excludes storm deaths by design; storm remains independently visible. |
| Deployed URL | **Blocked** | `vercel.json` and `.vercelignore` prepare a Vite static deployment, and the production build succeeds. README accurately says deployment is pending. | No Vercel project/account or deployed URL is available in the repository. Deployment cannot be truthfully verified or completed without that external target. |
| README | Pass | `README.md` covers setup, optional preprocessing, deployment, limitations, screenshots, and project structure. All tracked local Markdown links resolve. | The live-demo placeholder remains until deployment. |
| Architecture documentation | Pass | `ARCHITECTURE.md` describes the actual pipeline, lazy map loading, request IDs, coordinate authority, renderer, heatmaps, and limitations. | It is design documentation, not an independent benchmark. |
| Insight documentation | Pass | `INSIGHTS.md` contains three numbered observations, each with evidence, implication, and caveats. | Observations are descriptive; none establishes causality. |
| Exactly three defensible insights | Pass | `INSIGHTS.md` has exactly sections 1–3: late-quarter loot pickup samples, no recorded bot-classified loot pickups, and spatial movement concentration. | The supporting script prints more exploratory diagnostics; only those three are presented as submitted insights. |
| Reproducibility | Qualified | `analyze_insights.py` reads only committed `public/data`; every reported number is printed by the script. `requirements.txt` now pins NumPy, pandas, pyarrow, and Pillow for the offline scripts. | This host currently has no usable Python executable; its checked-in `.venv` points to a removed local interpreter. A clean Python install plus `python -m pip install -r requirements.txt` is required to rerun Python checks here. |

## Supplementary checks

| Check | Result | Evidence / note |
| --- | --- | --- |
| Console errors and warnings | Pass | No `error`, `warn`, or `warning` entries after map switches and selected-match playback. |
| Shipped app-data assets | Pass | Nine required data, track, and minimap URLs each returned HTTP 200 with non-empty content from the production preview. |
| Debug logging | Pass | No tracked `console.*`, `debugger`, TODO, FIXME, XXX, or HACK markers found outside dependencies/build output. |
| Secrets and accidental local paths | Pass | No credential-like values or user-profile paths found in tracked project content. `.env*` remains ignored defensively. |
| Dead code | Pass | TypeScript has `noUnusedLocals` and `noUnusedParameters`; source review found no disconnected runtime module. This is not a whole-program reachability proof for exported symbols. |
| Unused direct dependencies | Fixed | Removed unused `jsdom`; all remaining direct packages are referenced by application, build, typecheck, or test configuration. `npm audit` reported zero vulnerabilities. |
| Documentation links | Pass | All tracked local Markdown links resolve. |
| Production build | Pass | `npm run build` completed successfully in the final verification. |

## Changes made during this audit

- Added `requirements.txt` with the pinned Python dependencies used by the offline data
  pipeline and analysis scripts.
- Updated README preprocessing instructions and project tree to use that manifest.
- Removed unused `jsdom` from development dependencies and lockfile.

## Submission blocker

The only unresolved acceptance item found in this audit is a real deployed URL. The
repository is deployment-ready, but publishing requires the submitter’s Vercel project
or another hosting target. Do not replace the README placeholder with an invented URL.
