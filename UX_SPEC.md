# Level Designer Workspace — UX Specification

Design only. No implementation.

---

## 1. Who this is for, and the one fact that shapes everything

The user is a **Level Designer** asking questions about a *map*, not an analyst asking questions
about a *dataset*. They think in place-names and sightlines, not in aggregations.

The assignment names their four questions directly: *where players move, where fights break out,
where people die to the storm, and **which areas of the map get ignored***.

**The constraint that drives the design:** 743 of 796 matches (**93.3%**) contain exactly one
journey, and no match has more than 2 humans. A tool built around "select a match, watch it
unfold" would show a single dot wandering an empty map 93% of the time, and would look broken.

So the workspace is **aggregate-first**. The default view answers "what does this map look like
across everything we recorded", and match playback is a *drill-down* the designer enters when a
specific match becomes interesting. The requested workflow is preserved end to end — it is the
emphasis that shifts.

```
select map → see the whole map's behaviour immediately (no clicks)
           → narrow by date / actor
           → switch heatmap layers to interrogate movement, combat, death, loot
           → find a hotspot → marquee it → see what happened there
           → drill into one match → scrub it
           → follow one player
```

---

## 2. Overall layout

One page. One workspace. No routing, no tabs-as-pages, no modals except a fatal error.

The map is not a panel inside a dashboard — **the map is the application**, and controls sit at
its edges like a level editor viewport. Left rail is the only persistent chrome; the right rail
is contextual and absent until something is selected.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ LILA ▏ ▸Ambrose Valley  Grand Rift  Lockdown ▏ Feb 9–14 ▾ ▏ All actors ▾ ▏      ⚠ 7 notes│ 44px
├──────────────────────┬───────────────────────────────────────────────────────────────────┤
│ SHOWING              │                                                                   │
│ 836 journeys         │                                                                   │
│ 288 matches          │                                                                   │
│ 61,013 points        │                                                                   │
│                      │                                                                   │
│ ─ HEATMAP ─────────  │                                                                   │
│ ◉ Movement samples   │                                                                   │
│ ○ Kills        2,379 │                                                                   │
│ ○ Deaths         739 │                                                                   │
│ ○ Loot        11,632 │                M  A  P     C  A  N  V  A  S                        │
│ ○ None               │                                                                   │
│ ○ Low Activity       │                (fills every remaining pixel)                       │
│   radius  ──●─────   │                                                                   │
│                      │                                                                   │
│ ─ EVENTS ──────────  │                                                                   │
│ ☐ ✕ Kills      2,379 │                                                                   │
│ ☑ ✖ Deaths       739 │                                                                   │
│ ☑ ◆ Storm         39 │                                              ┌──────────────────┐ │
│ ☐ ● Loot      11,632 │                                              │ LEGEND           │ │
│                      │                                              │ ▁▂▃▅▇ 0–48 dwell │ │
│ ─ PATHS ───────────  │                                              │ ✖ death ◆ storm  │ │
│ ☐ Show paths (836)   │                                              └──────────────────┘ │
│   ⓘ too many to read │                                                                   │
│                      │                                                                   │
│ ─ MATCHES ─────────  │                                                                   │
│ [ search…          ] │                                                                   │
│ ▸ 23:58  1H 0B  6:22 │                                                                   │
│ ▸ 23:51  1H 6B  4:57 │                                                                   │
│ ▸ 23:44  2H 7B  9:03 │                                                                   │
│ …                    │                                                                   │
├──────────────────────┴───────────────────────────────────────────────────────────────────┤
│  ⓘ  Select a match to scrub its timeline                                                  │ 64px
└──────────────────────────────────────────────────────────────────────────────────────────┘
   260px                                                                            0px
```

**With a match selected** — the right rail appears, the timeline activates, paths auto-enable:

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ LILA ▏ ▸Ambrose Valley  Grand Rift  Lockdown ▏ Feb 11 ▾ ▏ All actors ▾ ▏       ⚠ 7 notes│
├──────────────────────┬────────────────────────────────────────────┬──────────────────────┤
│ SHOWING              │                                            │ MATCH ac049b28       │
│ 7 journeys           │                                            │ Feb 11 · 23:51 UTC   │
│ 1 match              │                                            │ 6:22 · Ambrose Valley│
│                      │                                            │                      │
│ ─ HEATMAP ─────────  │                                            │ ⚠ 1 journey recorded │
│ ○ Traffic  ◉ None    │              M A P   C A N V A S            │   roster size unknown│
│                      │                                            │                      │
│ ─ EVENTS ──────────  │                  ╭─────╮                   │ ── ACTORS ─────────  │
│ ☑ ✕ Kills          5 │                 ╱   ✖  ╲                   │ ◉ ▰ cfa03e9f  human  │
│ ☑ ✖ Deaths         1 │                ╱         ╲                 │ ○ ▱ 1436      bot    │
│ ☑ ◆ Storm          0 │        ●──●──●            ●                │ ○ ▱ 1440      bot    │
│ ☑ ● Loot          19 │                                            │ …                    │
│                      │                                            │                      │
│ ─ PATHS ───────────  │                                            │ ── AT 03:14 ───────  │
│ ☑ Show paths (7)     │                                  ┌────────┐│ cfa03e9f             │
│                      │                                  │ LEGEND ││ x −301.5  z −355.6   │
│ ─ MATCHES ─────────  │                                  └────────┘│ Loot ×2 in last 10s  │
│ ◂ back to all        │                                            │                      │
├──────────────────────┴────────────────────────────────────────────┴──────────────────────┤
│ ▶  ⟲  00:00 ├───●────╳────────●●──────────✖──────────────────┤ 06:22   1× 2× 4×  ⤢follow│
│                 loot  botkill  loot        death            ⓘ sampled every ~5s          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Rationale for the shape.** Everything competing with the map for space has been removed: no
header logo bar beyond one line, no card grid, no chart panel, no breadcrumb. The left rail is a
single scrolling column of controls ordered to match the workflow — *what am I looking at → how
is it shaded → what events → which paths → which match*. The right rail earns its space only
when the designer has selected something.

---

## 3. Filter placement

| Filter | Location | Control | Why there |
|---|---|---|---|
| **Map** | Top bar, left | 3 inline tabs | Only 3 values; it is the highest-order choice and should never be hidden in a dropdown. Each tab shows its journey count on hover. |
| **Date** | Top bar | Dropdown, multi-select | 6 values incl. `2026-02-09`. Defaults to all. Shows per-date counts inline. |
| **Actor type** | Top bar | Segmented: All / Humans / Bots | Cheap, high-frequency toggle. Counts shown (798 / 444). |
| **Match** | Left rail, bottom | Searchable list | Lower-frequency, needs vertical space, and is a drill-down rather than a filter. |
| **Region** | On the canvas | Shift+drag marquee | Spatial filters belong on the map, never in a sidebar. |

Filters are **additive and always visible in the SHOWING block** at the top of the left rail, so
the designer can never misread a filtered view as the whole dataset. Date and actor persist when
switching maps; match selection clears.

Deliberately **not** a filter: `actorIdConflict` and duplicate-row handling. Those live in the
data-quality panel (§14) because they are provenance, not exploration.

---

## 4. Statistics — numbers in context, not a chart panel

**There are no charts in the MVP.** Every statistic is a number rendered where the thing it
describes already is.

- **SHOWING block** (left rail, top, always): journeys · matches · points under the current
  filter. This is the sample size behind everything on screen.
- **Inline counts on every toggle**: `☑ ✖ Deaths 739`. The designer sees magnitude before
  deciding to turn a layer on.
- **Legend** carries the heatmap's numeric scale, so colour always maps to a real quantity.
- **Inspector** shows counts for the selected match, journey, or region.
- **Low-sample warning**: whenever a displayed statistic is computed from **n < 30**, it is
  rendered with a `⚠ n=5` marker. This matters — GrandRift has only 111 journeys and 5 storm
  deaths, and a heatmap there is close to meaningless without that caveat.

A chart would have to earn a large share of the map's pixels, and none of the four core questions
is better answered by a bar chart than by shading on the map itself.

---

## 5. Heatmap controls

Six modes, mutually exclusive (two overlaid density fields are unreadable):

| Layer | Source events | Label shown |
|---|---|---|
| **Movement** | `Position` + `BotPosition` | "Movement samples" |
| **Kills** | `Kill` + `BotKill` | "Kills" |
| **Deaths** | `Killed` + `BotKilled` + `KilledByStorm` | "Deaths" |
| **Loot** | `Loot` | "Loot" |
| **Low Activity** | inverse smoothed movement density inside observed envelope | "Low Activity" |
| **None** | — | turns shading off to read the artwork |

The only additional control is intensity. Smoothing is fixed per layer and intensity is
normalised to the current filter's distribution.

**"Movement samples" is named literally.** A bin count is the number of recorded movement
samples under the export's sampling behavior, not a promise of normalized time spent.

### Low Activity — the cautious sparse-telemetry view

This mode inverts smoothed recorded movement density inside the observed telemetry envelope. It
helps locate relatively sparse areas without claiming those areas are playable or avoided.

The observed envelope is a rectangular bound derived from telemetry, not authoritative playable
geometry. Zero samples can reflect inaccessible terrain, export coverage, or cohort filters.

---

## 6. Event controls

Four independent checkboxes, each with its total under the current filter. Independent (not
radio) because comparing kills against loot positions is a real question.

| Event | Marker | Default | Why |
|---|---|---|---|
| Kills (`Kill`, `BotKill`) | `✕` | **off** | 2,379 markers is dense; one click away |
| Deaths (`Killed`, `BotKilled`, `KilledByStorm`) | `✖` | **on** | 739 — sparse, and the highest-value design signal |
| Storm (`KilledByStorm`) | `◆` | **on** | 39 — rare, and storm tuning is a pure level-design lever |
| Loot (`Loot`) | `●` | **off** | 11,632 would swamp the map |

Storm deaths are split out of Deaths despite being a subset, because "did the storm kill people
where I expected" is its own question and n=39 would otherwise vanish inside 739.

**Human vs bot is encoded on the marker, not as a separate filter**: humans are filled, bots are
hollow. Consistent across paths, markers, and the actor list. Colour is reserved for event type,
so shape/fill carries actor type and the two never collide.

> **PvP honesty.** `Kill` and `Killed` total **6 rows in the entire dataset**. When the Kills
> layer is enabled, the legend states *"PvP: 3 events dataset-wide — combat here is
> effectively player-vs-bot."* Without that note a designer could badly misread the kill map.

---

## 7. Paths and player selection

**Paths are off by default in aggregate view.** 836 overlapping polylines is spaghetti, not
information — the traffic heatmap is the correct aggregate representation of movement.

Paths **auto-enable** when the visible journey count drops to **≤ 25** (via match selection or a
tight filter). The toggle explains itself when disabled: `☐ Show paths (836) ⓘ too many to read`.

**Player / journey selection** happens three ways:

1. **From the actor list** in the right rail when a match is selected — radio-style, one focused
   journey at a time, others dimmed rather than hidden so context survives.
2. **By clicking a path or marker** on the canvas.
3. **From a region marquee** — the region inspector lists every journey passing through it,
   click to focus.

A focused journey renders at full opacity with visible sample dots; all others drop to ~15%.
`⤢ follow` locks the viewport to the focused journey during playback.

**Sample dots are shown deliberately.** At ~5 s cadence a path is 52 samples, not a smooth curve.
Drawing an interpolated spline would imply fidelity that does not exist. Gaps beyond ~30 s render
**dashed** — with a maximum observed gap of 518 s, a straight line across one would be a lie.

---

## 8. Timeline and playback controls

The bottom strip is always present, with two states.

**Inert** (no match selected): a single line — `ⓘ Select a match to scrub its timeline`. It does
not pretend to be a global time axis, because aggregate view spans 6 days and scrubbing that
would be meaningless.

**Active** (match selected):

```
 ▶  ⟲   00:00 ├───●────╳────────●●──────────✖──────────────────┤ 06:22   1× 2× 4×   ⤢ follow
                 loot  botkill  loot        death              ⓘ sampled every ~5s
```

| Control | Behaviour |
|---|---|
| `▶` / `⏸` | Play/pause. **Space** also toggles. |
| `⟲` | Restart to t=0 |
| Scrubber | Drag to seek. **←/→** step one sample (~5 s); **Shift+←/→** jump to prev/next event |
| Event ticks | Every discrete event in the match, coloured by type, on the track. Click a tick to seek to it. |
| Speed | `1× 2× 4×` — no 0.5×; at 5 s sampling there is nothing to see in slow motion |
| `⤢ follow` | Viewport tracks the focused journey |

Time is displayed **match-relative** (`03:14 / 06:22`) as the primary reading, with absolute UTC
(`2026-02-11 23:54:17`) as a secondary line in the inspector. Match-relative is what a designer
reasons about; absolute time is provenance.

Playback interpolates linearly between samples and **the strip says so** — `ⓘ sampled every ~5s`
is permanent, not a tooltip.

---

## 9. Legend

Bottom-right, floating over the map, compact, never covering the centre. Contextual — it shows
only what is currently rendered:

```
┌────────────────────────────────────┐
│ TRAFFIC (dwell)                    │
│ ▁▂▃▅▇  0 ──────────── 48 samples   │
│         ≈ 0 ────────── 4:00 spent  │
│                                    │
│ ✖ death   ◆ storm death            │
│ ▰ human   ▱ bot                    │
└────────────────────────────────────┘
```

The dual scale (samples **and** the dwell time it implies) is what makes the heatmap actionable —
"4 minutes spent here" is a design fact; "48" is not. Collapsible to a single `ⓘ` chip.

---

## 10. Tooltips

Hover only, ~120 ms delay, positioned to never cover the cursor's target. Three kinds:

**Event marker**
```
Bot kill
03:14 into match · 23:54:17 UTC
cfa03e9f (human)
world  x −301.5  z −355.6
```

**Path sample**
```
cfa03e9f · human
03:10 · sample 38 of 63
world  x −290.4  z −340.1
```

**Heatmap bin**
```
Traffic
84 samples ≈ 7:00 dwell
from 23 journeys
```

Every tooltip shows **raw world coordinates**, because that is the value a designer pastes into
the engine to go look at the spot. Bin tooltips show *how many journeys* contributed, not just
the count — one player standing still for 7 minutes and 23 players passing through look identical
otherwise, and they mean opposite things for level design.

---

## 11. Loading states

Payload is small (33 KB index; 280 KB largest track file; ~175 KB minimap), so loading is brief —
but it must never show a blank rectangle where the map goes.

| Phase | What the designer sees |
|---|---|
| **Boot** (index + maps, ~35 KB) | Left rail skeleton; canvas shows the map name and a muted grid |
| **Minimap image** | The artwork appears **first** — it is the visual anchor and arrives independently of telemetry |
| **Track file** (~280 KB) | Minimap visible, dimmed slightly, with `Loading 836 journeys…` and a determinate progress bar |
| **Heatmap compute** | Sub-millisecond; no indicator. A spinner for a 0.5 ms operation is noise |
| **Map switch** | Previous map stays on screen until the new one is ready — no flash of empty state |

Track data is fetched **per map, on demand**, and cached in memory. Revisiting a map is instant.

---

## 12. Empty states

Empty states must always name the cause and offer the fix. Each is reachable with real data.

**Filter yields nothing** — e.g. Grand Rift + Feb 9 (that date has exactly 1 match, on Ambrose):
```
        No journeys match these filters.

        Grand Rift has no matches on 9 Feb.
        Nearest: 10 Feb (24 matches).

        [ Clear date filter ]   [ Show all dates ]
```

**Layer has no events under the filter** — e.g. Storm on Grand Rift, 1 day:
```
   No storm deaths in this selection.
   Grand Rift records 5 across all 6 days.   [ Show all dates ]
```

**Match with a single journey** — *not* an error, and the most common case:
```
   ⚠ 1 journey recorded for this match.
     Other participants were not captured in this export;
     the true roster size is unknown.
```
This wording is load-bearing. It must never say "1 player in this match" — that would state
something the data cannot support.

**Region marquee with nothing inside**:
```
   Nothing recorded in this region.
   [ Clear selection ]
```

---

## 13. Error states

| Failure | Treatment |
|---|---|
| **Track file fails to load** | Inline banner over the canvas: *"Couldn't load Ambrose Valley telemetry."* + `[ Retry ]`. Minimap and all other maps stay usable. |
| **Minimap image fails** | Canvas falls back to a neutral grid with the play-area outline drawn from `uvBounds`. Telemetry still renders and is still correctly positioned. Banner: *"Minimap artwork unavailable — positions are still accurate."* |
| **Schema version mismatch** | **Blocking modal.** *"This build expects data schema v1 but found v2. Rebuild with `python scripts/build_data.py`."* Rendering a mismatched contract could silently show wrong positions, which is worse than showing nothing. |
| **Manifest missing / malformed** | Blocking. *"Data not found. Run the pipeline before starting the app."* |
| **Canvas unsupported** | Blocking, plain text. No fallback renderer in MVP. |
| **Unknown `map_id` in data** | Should be impossible — the pipeline fails the build on it. If seen: skip that map, banner it, keep going. |

Only two errors block the whole app, and both are cases where continuing would show a *plausible
but wrong* picture. Everything else degrades locally.

---

## 14. Data-quality panel

The `⚠ 7 notes` chip in the top bar opens a plain, scrollable list read straight from
`manifest.dataQuality` — the same seven anomalies the pipeline reported, in the designer's words:

- 1,417 duplicate rows removed (1,234 of them loot) — *loot counts are ~9.6% lower than raw*
- 743 matches have a single journey — *rosters are incomplete*
- 17 journeys have a bot-style id but human behaviour — *classified as human*
- 342 rows sit in a day folder that disagrees with their timestamp — *date derived from timestamp*
- 3 journeys have one position sample — *shown as a point, no path*
- no extraction event exists — ***extraction rate is not measurable***

It is a disclosure surface, not a dashboard. A designer who acts on a number deserves to know how
it was made.

---

## 15. Visible immediately vs. requires interaction

### Visible immediately — zero clicks, on load

The default is **Ambrose Valley** (836 journeys, the richest map), **all dates**, **all actors**,
**Traffic heatmap on**, **Deaths + Storm markers on**, paths off.

That single view already answers three of the four core questions: where players go, where they
die, and where the storm kills them.

| Immediately visible | Why |
|---|---|
| The map, at full size, correctly oriented | It is the subject |
| Movement-sample heatmap | "Understand overall movement" with no interaction |
| Death + storm markers | Sparse, high-signal, the designer's first question |
| Sample size (journeys / matches / points) | Never let a filtered view read as the whole |
| Every layer's event count | Magnitude before commitment |
| Legend with real units | Colour must mean something |
| Data-quality chip | Caveats are one click, never hidden |

### Requires interaction

| Action | Interaction |
|---|---|
| Change map / date / actor | Top bar |
| Switch heatmap layer | Left rail radio |
| Show kills or loot markers | Left rail checkbox |
| Low Activity area | Left rail heatmap mode |
| See individual paths | Select a match, or filter to ≤25 journeys |
| Inspect a point or event | Hover |
| Investigate a region | **Shift + drag** marquee on the canvas |
| Play back a match | Select match → `▶` or Space |
| Follow one player | Select journey in right rail → `⤢ follow` |
| Read raw world coordinates | Hover tooltip |
| See data-quality detail | `⚠` chip |

One modifier key (Shift), no mode switcher, no right-click menus.

---

## 16. Deliberately excluded from MVP

Each exclusion is a decision, not an omission.

| Excluded | Why |
|---|---|
| **Charts of any kind** — time series, bar charts, distributions | None of the four core questions is better answered off-map. A chart panel would take pixels from the map and turn a level-design tool into a generic analytics dashboard. |
| **Multi-page / routed navigation** | One workspace. Everything is a state of the same view. |
| **Player-centric browsing** ("all matches for user X") | The unit of level-design interest is the *place*, not the person. 245 human ids with a median of ~3 journeys each does not support a meaningful player profile. |
| **Cross-map comparison view** | Coordinate systems and scales differ per map; a side-by-side invites false equivalence. Switching maps is one click. |
| **Extraction / survival metrics** | **No extraction event exists.** Building this would require inventing a definition the data cannot support. |
| **Storm-front visualisation** | No storm-state telemetry exists — only 39 death events. Any animated storm boundary would be fabricated. |
| **Killer↔victim linking** | The 3 `Kill`/`Killed` pairs share one actor, position and timestamp; the relationship is undetermined. |
| **Aggregate multi-match playback** | Matches start at unrelated wall-clock times; synchronising them on match-relative time would imply a shared event that never happened. |
| **Path smoothing / interpolated splines** | 5 s sampling. Smooth curves would imply precision that does not exist. |
| **Elevation (`y`) visualisation** | Top-down projection; `y` is retained in the data and shown in tooltips but not encoded visually. Deferring until it answers a real question. |
| **Adjustable bin size, colour ramp pickers, opacity sliders per layer** | Over-configuration. Radius plus layer choice covers the real need. |
| **Export / share / annotation** | Genuinely useful for a design team, and the first thing I would add after MVP. Out of scope at 10–15 h. |
| **Mobile layout** | This is a desktop tool used beside an engine editor. Responsive down to ~1100 px; below that, a plain "best viewed on desktop" notice. |
| **Dark/light theme toggle** | Ships dark only — it sits next to Unity/Unreal and the minimaps are dark artwork. |

---

## 17. Success test

The design succeeds if a Level Designer who has never seen the tool can, **within 30 seconds and
without instructions**:

1. Tell where players spend their time on Ambrose Valley.
2. Point at where they die, and where the storm specifically kills them.
3. Name one region nobody goes to.

And within two minutes: find an interesting hotspot, marquee it, discover which matches produced
it, open one, and watch that player walk into it.
