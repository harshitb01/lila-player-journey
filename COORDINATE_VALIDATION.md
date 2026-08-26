# Coordinate Transformation Validation

**Verdict: the documented transform is correct and should be used as-is.** No change to the
formula, the scale values, or the origin values is warranted. One clarification is required
about the final scaling constant — see §7.

**Reproduce with:**

```bash
python scripts/coordinate_validation.py --overlays
npx vitest run
```

| Artefact | Path |
|---|---|
| Authoritative map constants | [`map-config.json`](map-config.json) |
| Transform (browser) | [`src/utils/coordinates.ts`](src/utils/coordinates.ts) |
| Unit tests (47) | [`src/utils/coordinates.test.ts`](src/utils/coordinates.test.ts) |
| Parity tests (5) | [`src/utils/coordinates.parity.test.ts`](src/utils/coordinates.parity.test.ts) |
| Validation script | [`scripts/coordinate_validation.py`](scripts/coordinate_validation.py) |
| Overlay images | `out/coordinate_validation/*.png` |

---

## 1. The transform under test

Implemented as pure formula functions, with constants loaded from `map-config.json` and
**no clamping anywhere**:

```
u = (x - originX) / scale
v = (z - originZ) / scale

pixelX = u * size
pixelY = (1 - v) * size
```

Baseline constants, transcribed from the dataset README into the shared map contract:

| Map | scale | originX | originZ |
|---|---:|---:|---:|
| AmbroseValley | 900 | −370 | −473 |
| GrandRift | 581 | −290 | −290 |
| Lockdown | 1000 | −500 | −500 |

Only `x` and `z` participate. `y` is elevation and is excluded — a unit test asserts the
projection function takes exactly three parameters, so a later refactor cannot quietly
introduce it.

---

## 2. README worked example — reproduced exactly

| Quantity | README | Computed |
|---|---|---|
| `u` | 0.0762 | **0.076167** |
| `v` | 0.1305 | **0.130500** |
| `pixel_x` | 78 | **77.9947** → 78 |
| `pixel_y` | 890 | **890.3680** → 890 |

**MATCH: YES.** The README's arithmetic is internally consistent and our implementation
reproduces it.

---

## 3. All real positions, every map

Tested against **all 89,104 rows** — not a sample.

UV extent per map:

| Map | Points | u min | u max | v min | v max |
|---|---:|---:|---:|---:|---:|
| AmbroseValley | 61,013 | 0.0500 | 0.7464 | 0.1033 | 0.9264 |
| GrandRift | 6,853 | 0.1103 | 0.9408 | 0.1652 | 0.7919 |
| Lockdown | 21,238 | 0.0934 | 0.8484 | 0.2149 | 0.8292 |

Mapped pixel extent (1024 reference square):

| Map | pixel_x min | pixel_x max | pixel_y min | pixel_y max |
|---|---:|---:|---:|---:|
| AmbroseValley | 51.24 | 764.34 | 75.37 | 918.19 |
| GrandRift | 112.97 | 963.40 | 213.06 | 854.81 |
| Lockdown | 95.61 | 868.72 | 174.86 | 803.95 |

**Global extremes:** `pixel_x` ∈ [**51.2376**, **963.3995**], `pixel_y` ∈ [**75.3690**, **918.1948**].

### Percentage inside / outside [0, 1024]

| Map | Points | In bounds | Out of bounds | % in | % out |
|---|---:|---:|---:|---:|---:|
| AmbroseValley | 61,013 | 61,013 | **0** | **100.0000%** | 0.0000% |
| GrandRift | 6,853 | 6,853 | **0** | **100.0000%** | 0.0000% |
| Lockdown | 21,238 | 21,238 | **0** | **100.0000%** | 0.0000% |
| **Total** | **89,104** | **89,104** | **0** | **100.0000%** | **0.0000%** |

Every mapped coordinate sits comfortably inside the frame, with a margin of at least 51 px on
every side. Not a single point is even marginally out of range.

---

## 4. Out-of-range investigation

**There are zero out-of-range points**, so the four candidate explanations are all vacuous:

| Hypothesis | Finding |
|---|---|
| (a) Expected edge behaviour | Nothing sits beyond any edge. Closest approach is 51 px from the frame. |
| (b) Invalid telemetry | No coordinate escapes its map's bounds. No NaN or Inf exists (§ DATA_ANALYSIS.md). |
| (c) Incorrect mapping | No scale or origin error is detectable — an error of either kind would push extremes past 0 or 1024. |
| (d) Wrong map assignment | Tested separately below. |

### Wrong map assignment (d)

If journeys were mislabelled, their own map's constants would tend to push points off-map while
another map's would contain them. Cross-applying every map's constants to every map's points:

| Points from ↓ / constants → | AmbroseValley | GrandRift | Lockdown |
|---|---:|---:|---:|
| **AmbroseValley** | **100.00%** | 82.83% | 100.00% |
| **GrandRift** | 100.00% | **100.00%** | 100.00% |
| **Lockdown** | 99.85% | 87.90% | **100.00%** |

**Every map's own constants contain 100% of its own points** — the necessary condition holds
everywhere. There is no map whose points fit a different configuration *better* than their own.

The off-diagonal values are **not** evidence of mislabelling. Lockdown's world region
(1000 units from −500) geometrically contains AmbroseValley's (900 units from −370), so
containment under a larger config is arithmetically inevitable and carries no information.
Containment is a necessary but not sufficient test — which is exactly why §5 exists.

---

## 5. Orientation — the question in-bounds testing cannot answer

**In-bounds coverage does not validate orientation.** Flipping `v`, flipping `u`, or swapping the
axes all keep every point inside [0,1]², because both components are in range. Arithmetic alone
cannot distinguish them; only agreement with the artwork can.

Four candidate orientations were tested against the actual minimap images:

| Candidate | Formula |
|---|---|
| `documented` | `(u·w, (1−v)·h)` |
| `no_v_flip` | `(u·w, v·h)` |
| `u_flipped` | `((1−u)·w, (1−v)·h)` |
| `axes_swapped` | `(v·w, (1−u)·h)` |

### Objective metric

Every minimap is surrounded by a near-black out-of-play margin. A correct projection places
almost no telemetry there; a wrong one drops points into the void. Sampling the underlying
minimap pixel for all 89,104 points turns this from a judgement call into a measurement.

**% of points landing on out-of-play pixels (luminance < 28) — lower is better:**

| Map | `documented` | `no_v_flip` | `u_flipped` | `axes_swapped` |
|---|---:|---:|---:|---:|
| AmbroseValley | **2.50%** | 14.40% | 32.12% | 24.46% |
| GrandRift | **12.32%** | 19.57% | 16.62% | 26.57% |
| Lockdown | **2.56%** | 17.33% | 8.05% | 18.89% |

**`documented` wins on all three maps — unanimous.** On AmbroseValley it is 5.8× better than the
next candidate, and on Lockdown 3.1× better.

*Honest caveat:* the absolute percentages are sensitive to the luminance threshold and to each
map's art style — GrandRift's 12.32% is inflated because its dark-brown roads and its concave
silhouette both fall under the threshold. The **ranking** is the result that matters, and it is
stable and unanimous.

### Visual confirmation

The overlays confirm the metric directly:

- **AmbroseValley** (`documented`) — dense clusters sit precisely inside building footprints
  (the northern compound, the central oval structure, the eastern warehouses, the southern
  town), paths trace the road network, and both the river and the out-of-bounds margin are
  avoided. Under `no_v_flip`, a dense cluster floats in open water off the western shore and the
  southern town is left empty — an unmistakable failure.
- **Lockdown** (`documented`) — points cluster on the harbour complex, the industrial zone and
  the central compound, follow the roads, and the northern bay is **completely free** of points.
- **GrandRift** (`documented`) — points trace the road network and cluster at the labelled POIs
  (Burnt Zone, Engineer's Quarters, Mine Pit).

> **Incidental finding:** GrandRift's minimap is a *design annotation* map carrying named POIs
> (Maintenance Bay, Cave House, Mine Pit, Labour Quarters, Engineer's Quarters, Burnt Zone, Gas
> Station) and coloured zone overlays. The other two are plain top-down renders. These names are
> the vocabulary a Level Designer actually thinks in, and are worth surfacing in the tool.

**Orientation is confirmed: `v` is flipped, `u` is not, axes are not swapped — exactly as
documented.**

---

## 6. Coverage of the mapped area

| Map | u span | v span | Bounding box as % of image |
|---|---:|---:|---:|
| AmbroseValley | 0.6964 | 0.8231 | 57.3% |
| GrandRift | 0.8305 | 0.6267 | 52.0% |
| Lockdown | 0.7550 | 0.6143 | 46.4% |

Roughly half of each minimap's square is never reached. **This is not evidence of a projection
error.** The overlays show why: every map is an irregular island or plateau inside a square
image, so the corners are out-of-play by construction. Distinguishing unplayable terrain from
genuinely ignored space needs the artwork, not the numbers — and is a product question for the
dead-space feature, not a correctness question.

---

## 7. The one clarification: `1024` is not a real image size

The README's final step hardcodes 1024 and states the minimaps are 1024×1024. **They are not:**

| Map | README claims | Measured |
|---|---|---|
| AmbroseValley | 1024 × 1024 | **4320 × 4320** |
| GrandRift | 1024 × 1024 | **2160 × 2158** (not square) |
| Lockdown | 1024 × 1024 | **9000 × 9000** |

This does **not** invalidate the transform. The UV stage is resolution-independent and fully
validated; 1024 is simply a reference square, not a real target. The implementation therefore
parameterises the final step as `width`/`height`, defaulting to 1024×1024 so that calling it
with no size reproduces the README's worked example byte-for-byte. A unit test asserts that.

Two consequences worth recording:

1. **GrandRift is 2 px short vertically** (2160 × 2158). The projection assumes a square world
   region, so a uniform UV→pixel mapping introduces a 0.09% vertical distortion. This is below
   one pixel at any display size we will use, and is documented rather than corrected — altering
   the artwork would be a larger risk than the error itself. `uvToPixel` takes independent
   `width` and `height` so the true dimensions can be honoured.
2. **The three source images total 23.3 MiB**, which is a page-weight problem for a hosted tool —
   a pipeline concern, not a correctness one.

---

## 8. Test coverage

**52 tests, all passing.** `npx tsc --noEmit` is clean.

`coordinates.test.ts` (47) covers: the README example; constants matching the README; corner,
centre and far-corner mappings; linearity; equal scale on both axes; `y` exclusion; **absence of
clamping** (u = −1 and u = 2 are returned unchanged); per-map constant isolation; the v-flip
direction; non-square render targets; real minimap resolutions; world↔uv, world↔pixel and
uv↔pixel round trips; boundary-inclusive bounds predicates; NaN rejection; a throw on unknown
`map_id` rather than a silent fallback; and the observed coordinate extremes of all three maps.

`coordinates.parity.test.ts` (5) guards **cross-language drift**. The pipeline projects in
Python and the browser projects in TypeScript; if those diverge, every rendered position is
silently wrong while both suites still pass. The validation script emits 600 vectors sampled
from real telemetry (200 per map) and the TypeScript suite asserts agreement to within **1e-12**
on UV and pixel values. Max observed divergence is below that threshold on all 600.

---

## 9. Verdict

> **Use the documented transform as-is.** Do not modify the formula, the scale values, or the
> origin values.

| Question | Answer |
|---|---|
| Does it reproduce the README example? | **Yes**, exactly |
| Does it contain all real points? | **Yes** — 89,104 / 89,104 = 100.0000% |
| Any out-of-range points? | **Zero** |
| Any evidence the README constants are wrong? | **None** |
| Is the orientation correct? | **Yes** — confirmed objectively and visually on all 3 maps |
| Any mislabelled maps? | **None detected** |
| Is clamping needed? | **No** — and none is implemented |

**Changed:** only the hardcoded `1024`, generalised to a render-size parameter that defaults to
1024. This is a necessary generalisation for images that are 4320²/2160×2158/9000², not a
correction — the documented arithmetic is preserved exactly at the default.

**Residual risk:** the orientation metric is a proxy (out-of-play pixel darkness), not ground
truth from the engine. It is corroborated by direct visual inspection on all three maps and by
100% in-bounds coverage, and the three lines of evidence agree. Should the engine's authoritative
map config ever become available, it should supersede this validation.

**Mapping is validated. Cleared to proceed.**
