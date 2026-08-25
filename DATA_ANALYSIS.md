# Dataset Forensic Analysis

Complete inspection of the LILA BLACK telemetry drop, measured directly from the Parquet files.

**Reproduce with:**

```bash
python scripts/analyze_dataset.py --json out/analysis.json
```

Every number below is emitted by that script. Nothing here is carried over from the dataset
README — the README is treated as a set of claims to be tested, and is verified in §13.

**Convention used throughout:** statements are *verified observations* unless explicitly tagged
**[HYPOTHESIS]**. Hypotheses are inferences that go beyond the stored bytes; each one states the
evidence supporting it and what would falsify it.

---

## 1. File inventory and integrity

| Metric | Value |
|---|---|
| Files discovered | **1,243** |
| Readable as Parquet | **1,243** (100%) |
| Malformed / unreadable | **0** |
| Zero-row files | **0** |
| Total rows | **89,104** |
| Total bytes | 8,371,211 (8.0 MiB) |
| Writer (`created_by`) | `parquet-go version latest` (all 1,243 files) |
| Compression | SNAPPY, 1 row group per file |

Per day folder:

| Folder | Files | Rows | Bytes |
|---|---:|---:|---:|
| February_10 | 437 | 33,687 | 2,991,430 |
| February_11 | 293 | 21,235 | 1,992,563 |
| February_12 | 268 | 18,429 | 1,783,860 |
| February_13 | 166 | 11,106 | 1,103,813 |
| February_14 | 79 | 4,647 | 499,545 |

**Filename integrity — all clean:**

- Filenames not matching `{user_id}_{match_id}.nakama-0`: **0**
- Filename `user_id` ≠ content `user_id`: **0**
- Filename `match_id` ≠ content `match_id`: **0**

No file contains more than one `user_id`, `match_id`, or `map_id`. No match spans more than one
map. The file-per-journey model asserted by the README holds exactly.

---

## 2. Schema, physical and logical types

**All 1,243 files share one identical schema.** No drift. (Note: comparing `str(pf.schema)`
directly is a trap — the repr embeds the object's memory address, so every file appears unique.
The script fingerprints columns and types structurally instead.)

```
required group field_id=-1 parquet_go_root {
  required binary field_id=0 user_id  (String);
  required binary field_id=0 match_id (String);
  required binary field_id=0 map_id   (String);
  required float  field_id=0 x;
  required float  field_id=0 y;
  required float  field_id=0 z;
  required int64  field_id=0 ts (Timestamp(isAdjustedToUTC=false, timeUnit=milliseconds,
                                           is_from_converted_type=false,
                                           force_set_converted_type=false));
  required binary field_id=0 event;
}
```

| Column | Parquet physical | Parquet logical | Converted | Arrow type | Nullable |
|---|---|---|---|---|---|
| `user_id` | BYTE_ARRAY | String | UTF8 | `string` | No |
| `match_id` | BYTE_ARRAY | String | UTF8 | `string` | No |
| `map_id` | BYTE_ARRAY | String | UTF8 | `string` | No |
| `x` | FLOAT | *none* | NONE | `float` (32-bit) | No |
| `y` | FLOAT | *none* | NONE | `float` (32-bit) | No |
| `z` | FLOAT | *none* | NONE | `float` (32-bit) | No |
| `ts` | **INT64** | **Timestamp(isAdjustedToUTC=false, timeUnit=milliseconds)** | NONE | `timestamp[ms]` | No |
| `event` | BYTE_ARRAY | ***none*** | NONE | **`binary`** | No |

Two details worth noting: `event` carries **no** String logical annotation, which is why it
arrives as raw `bytes` and must be explicitly decoded; and every field is `required`, so nulls
are structurally impossible.

---

## 3. Missing values

| Check | Result |
|---|---|
| Parquet-level `null_count`, all columns | **0** |
| Pandas-level nulls, all columns | **0** |
| `NaN` in `x`, `y`, `z` | **0** |
| `Inf` in `x`, `y`, `z` | **0** |
| Empty strings in `user_id` / `match_id` / `map_id` / `event` | **0** |

The dataset has no missing values of any kind.

---

## 4. Identities

| Metric | Value |
|---|---|
| Unique `user_id` | **339** (245 UUID, 94 numeric) |
| Unique `match_id` | **796** |
| **Unique journeys** (`user_id` + `match_id`) | **1,242** |
| Unique `map_id` | 3 — `AmbroseValley`, `GrandRift`, `Lockdown` |
| Every `match_id` ends in `.nakama-0` | Yes |

**1,243 files but 1,242 journeys** — one file is delivered twice (§8).

Rows per map: AmbroseValley 61,013 · Lockdown 21,238 · GrandRift 6,853.

---

## 5. Event types and frequency

Exactly **8** distinct event types, matching the README's vocabulary.

| Event | Count | % of rows |
|---|---:|---:|
| `Position` | 51,347 | 57.63% |
| `BotPosition` | 21,712 | 24.37% |
| `Loot` | 12,885 | 14.46% |
| `BotKill` | 2,415 | 2.71% |
| `BotKilled` | 700 | 0.79% |
| `KilledByStorm` | 39 | 0.044% |
| `Kill` | **3** | 0.003% |
| `Killed` | **3** | 0.003% |

Movement events are **82.0%** of rows, not the "~85%+" the README states.

`Kill`/`Killed` (human-vs-human combat) total **six rows across 796 matches**. All three `Kill`
rows are paired with a `Killed` row at the *same* `user_id`, `match_id`, coordinates and
timestamp. What that pairing means is **ambiguous** — see §14.

By map:

| Event | AmbroseValley | GrandRift | Lockdown |
|---|---:|---:|---:|
| `Position` | 36,189 | 3,740 | 11,418 |
| `BotPosition` | 12,565 | 1,988 | 7,159 |
| `Loot` | 9,955 | 880 | 2,050 |
| `BotKill` | 1,797 | 192 | 426 |
| `BotKilled` | 486 | 46 | 168 |
| `KilledByStorm` | 17 | 5 | 17 |
| `Kill` / `Killed` | 2 / 2 | 1 / 1 | 0 / 0 |

---

## 6. Humans vs bots

Two independent classifiers were compared.

**Event counts by id format** — `Loot`, `BotKill` and `BotKilled` appear under *both* id formats,
so they are not discriminative. Only `Position` vs `BotPosition` are:

| id format | `BotKill` | `BotKilled` | `BotPosition` | `Kill` | `Killed` | `KilledByStorm` | `Loot` | `Position` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| numeric | 183 | 297 | 21,712 | 0 | 0 | 0 | **115** | **636** |
| uuid | 2,232 | 403 | 0 | 3 | 3 | 39 | 12,770 | 50,711 |

**Movement vocabulary is a total, mutually exclusive partition** (journey level):

| | has `BotPosition` = False | has `BotPosition` = True |
|---|---:|---:|
| has `Position` = False | **0** | 444 |
| has `Position` = True | 798 | **0** |

0 journeys have both. 0 journeys have neither. Verified across all 1,242 journeys.

The bot cohort is also **behaviourally pure**: the 444 `BotPosition` journeys emit only
`BotPosition` (21,712), `BotKilled` (296) and `BotKill` (170) — zero `Loot`, `Kill`, `Killed` or
`KilledByStorm`.

**Agreement between classifiers:**

| | vocabulary: bot | vocabulary: human |
|---|---:|---:|
| **id says bot** | 444 | **17** |
| **id says human** | **0** | 781 |

**17 journeys disagree** (1.37%, 765 rows), all in one direction, involving only three ids:

| user_id | journeys | human-vocabulary | bot-vocabulary |
|---|---:|---:|---:|
| `1379` | 2 | 2 | 0 |
| `1402` | 1 | 1 | 0 |
| `1429` | 17 | **14** | **3** |

`user_id 1429` appears as human in 14 matches and as a bot in 3. **A `user_id` is therefore not a
stable actor property**, which rules out any id-based classifier.

Journey counts under the vocabulary rule: **798 human, 444 bot.**

---

## 7. Coordinate ranges

| Map | axis | min | max | span |
|---|---|---:|---:|---:|
| AmbroseValley | x | −324.97 | 301.79 | 626.75 |
| AmbroseValley | y | 100.00 | 162.67 | 62.67 |
| AmbroseValley | z | −380.01 | 360.76 | 740.76 |
| GrandRift | x | −225.90 | 256.62 | 482.52 |
| GrandRift | y | 8.14 | 46.86 | 38.72 |
| GrandRift | z | −194.00 | 170.11 | 364.12 |
| Lockdown | x | −406.63 | 348.36 | 754.99 |
| Lockdown | y | 32.58 | 70.55 | 37.97 |
| Lockdown | z | −285.10 | 329.24 | 614.34 |

`y` occupies a distinct, non-overlapping band per map (Ambrose ~100–163, Lockdown ~33–71,
GrandRift ~8–47), consistent with the README's statement that `y` is elevation.

**UV projection using the README's constants** — `u = (x−ox)/scale`, `v = (z−oz)/scale`:

| Map | u range | v range | In bounds | Out of bounds |
|---|---|---|---:|---:|
| AmbroseValley | 0.0500 – 0.7464 | 0.1033 – 0.9264 | 61,013 | **0** |
| GrandRift | 0.1103 – 0.9408 | 0.1652 – 0.7919 | 6,853 | **0** |
| Lockdown | 0.0934 – 0.8484 | 0.2149 – 0.8292 | 21,238 | **0** |

**100.00% of all 89,104 points fall inside [0,1]².** The scale and origin constants are correct.

> **Important limitation:** in-bounds coverage does **not** validate orientation. Flipping `v`,
> flipping `u`, or swapping the axes would also leave every point inside [0,1]. Orientation can
> only be confirmed visually against the minimap artwork. **Unverified as of this document.**

Observed coverage does not fill the image: AmbroseValley occupies only u∈[0.05, 0.75]. Whether
that is unplayable terrain or genuinely unvisited space is not determinable from telemetry alone.

Minimap images were measured directly and are **not** 1024×1024:

| File | Actual dimensions | Size |
|---|---|---:|
| `AmbroseValley_Minimap.png` | 4320 × 4320 | 9.3 MiB |
| `GrandRift_Minimap.png` | **2160 × 2158** (not square) | 2.7 MiB |
| `Lockdown_Minimap.jpg` | 9000 × 9000 | 11.3 MiB |

GrandRift's 2-pixel vertical shortfall (0.09%) matters because the projection assumes a square
world region.

---

## 8. Duplicate records

### 8a. One file delivered twice

`cfa03e9f-81f6-41ef-a0fa-30c7e830f4ed_ac049b28-8116-4ff1-9e60-4be0537b8cc9.nakama-0` exists in
**both** `February_10/` and `February_11/`, **byte-identical** (88 rows each, verified by frame
equality). This is the sole source of the 1,243-files-vs-1,242-journeys gap.

It is also the sole cause of the only match whose journeys span two day folders
(`ac049b28…`, 7 journeys): the duplicated human journey sits in both folders while its 6 bot
journeys sit only in `February_11/`.

### 8b. Exact duplicate rows

**Definition:** identical values in all eight data columns, with `x/y/z` compared bitwise
(float32), excluding loader metadata.

Row reconciliation: **89,104** delivered → −88 (duplicate file) → **89,016** → −1,417 (exact
duplicate rows) → **87,599 canonical rows**.

| Event | Raw | Duplicates | Deduped | Dup % |
|---|---:|---:|---:|---:|
| `Loot` | 12,866 | **1,234** | 11,632 | 9.59% |
| `Position` | 51,284 | 147 | 51,137 | 0.29% |
| `BotKill` | 2,410 | 34 | 2,376 | 1.41% |
| `BotKilled` | 699 | 2 | 697 | 0.29% |
| `BotPosition` | 21,712 | 0 | 21,712 | 0% |
| `Kill` / `Killed` / `KilledByStorm` | 3 / 3 / 39 | 0 | unchanged | 0% |

Duplication is **not** confined to `Loot`, though `Loot` is 87% of it.

### 8c. The dedupe key matters

| Key | Rows removed |
|---|---:|
| Strict — all 8 columns | **1,417** |
| Coarse — `(user_id, match_id, ts, event)` | **1,503** |

The coarse key destroys **86 additional rows**, and those 86 survive strict dedupe **with
distinct coordinates** — they are genuinely separate events that share a timestamp. Because `ts`
granularity is 1 second (§9), multiple real events legitimately land in the same second. The
strict key is the only safe choice.

---

## 9. Timestamp forensics

This column is the single most misleading part of the dataset.

### 9a. What the file itself declares — verified

| Property | Value |
|---|---|
| Physical type | **`INT64`** |
| Logical type | **`Timestamp(isAdjustedToUTC=false, timeUnit=milliseconds)`** |
| Converted type | `NONE` |
| Arrow type | `timestamp[ms]` |
| Written by | `parquet-go version latest` |

`isAdjustedToUTC=false` means the writer asserts **no timezone semantics**. Readers are entitled
to treat these as naive local timestamps, and some engines will apply a session timezone to them.

### 9b. Raw INT64 payload — verified, no unit applied

| Property | Value |
|---|---|
| min | **1,770,681,535** |
| max | **1,771,081,300** |
| span | 399,765 |
| Distinct values | 58,356 |
| Smallest positive step within a journey | **1 raw unit** |
| Values that are multiples of 1000 | **89 of 89,104** |

The payload has 1-raw-unit granularity. It is **not** a whole-second clock scaled into
milliseconds — that would make every value a multiple of 1000, and only 0.1% are.

### 9c. Decoding under each candidate unit — verified

| Interpretation | Decoded range |
|---|---|
| **Declared unit (ms)** | `1970-01-21 11:51:21.535` → `1970-01-21 11:58:01.300` |
| Alternative (seconds) | `2026-02-09 23:58:55` → `2026-02-14 15:01:40` |

Taking the declared unit literally places five days of 2026 production data inside a **6½-minute
window in January 1970**.

### 9d. Four independent tests

| Test | Under declared unit (ms) | Under seconds |
|---|---|---|
| **1. Reproduces day-folder labels** | **0.00%** of rows | **99.51%** of rows |
| **2. Journey duration** | median **0.31 s**, max 0.89 s | median **5.10 min**, max 14.83 min |
| **3. Implied movement speed** | **2,684 units/s** | **2.68 units/s** |
| **4. Sampling cadence** | every 5 ms (200 Hz) | every **5.0 s** (modal, exact) |

Test 1's residual is **fully accounted for**, not noise. All 436 disagreeing rows belong to
**5 matches that run up to or across UTC midnight**:

| Folder | Decoded date | Rows | Journeys | Matches | UTC window |
|---|---|---:|---:|---:|---|
| February_10 | 2026-02-09 | 14 | 1 | 1 | 23:58:55 – 23:59:58 |
| February_11 | 2026-02-10 | 422 | 10 | 4 | 23:51:05 – 23:59:59 |

Sweeping every UTC offset from −12 h to +12 h, **+0 h maximises agreement** (99.511%), so the
folders are UTC-day buckets. Three journeys genuinely straddle midnight; the remainder are late
-night matches filed into the next day's folder. **The day folder is therefore not a reliable
date field.**

### 9e. Behaviour within a match — verified

The README states `ts` "represents time elapsed within the match". If true, every journey would
start near zero.

- Journey start values range **1,770,681,535 → 1,771,081,065**.
- Journeys starting below 86,400 (one day): **0 of 1,242**.

For the 53 matches containing more than one journey:

- Spread of journey start times within a match: median 5, p95 5, **max 5** raw units.
- Matches whose journeys **overlap in time: 53 of 53.**

Co-match journeys therefore sit on a **shared clock**, and every participant's telemetry begins
within a single 5-second sampling tick. There is no staggered join in this data.

### 9f. Conclusion

> **[HYPOTHESIS — very strongly supported]** One raw unit is **one second**, and the stored
> integer is a **Unix epoch timestamp in seconds**, written into a field the encoder declared as
> milliseconds without converting. The `ts` column is therefore **absolute wall-clock time**, and
> the README's "elapsed within the match" description is incorrect.
>
> **Supporting evidence:** four independent tests above agree, spanning calendar alignment,
> session duration, movement physics and sampling cadence. Only under the seconds reading do all
> four produce plausible values simultaneously.
>
> **What would falsify it:** a value not divisible into a sensible 2026 date; journeys whose
> decoded dates contradict their folders beyond the 5 midnight matches already accounted for; or
> a game design in which matches genuinely last 0.31 seconds.

This remains a hypothesis because the writer's intent cannot be read from the bytes. The
*measurements* are facts; the *unit* is an inference.

### 9g. Safest conversion to a match-relative timeline

The robust construction avoids the disputed unit almost entirely:

```python
ts_raw    = table.column("ts").cast(pa.int64())        # read the payload, not the type
match_t0  = ts_raw.groupby(match_id).transform("min")  # anchor per MATCH
t_rel     = ts_raw - match_t0                          # seconds since match start
```

**Why this is the safest form:**

1. **Never call a timestamp decoder on this column.** Casting to `int64` at read time sidesteps
   both the wrong `timeUnit` and the `isAdjustedToUTC=false` flag, which can otherwise cause an
   engine to shift values by a session timezone. Ordering and spacing come straight from the
   integers.
2. **Subtraction cancels the epoch.** `t_rel` is correct regardless of what instant the epoch
   represents. Only the *scale* (1 unit = 1 s) affects the axis label, and never the geometry of
   the timeline.
3. **Anchor on the match, not the journey.** Journey start offsets within a match reach 5 raw
   units; anchoring per journey would silently align actors who did not actually start together.
   Match-anchoring is validated by 53/53 multi-journey matches overlapping in time.
4. **It is verifiable.** `min(t_rel) = 0` and negative values = **0**, both asserted by the
   script.

Resulting match lengths: median **382 s**, p95 770 s, **max 890 s** (14.8 min) — with a hard
ceiling well under 15 minutes, consistent with a fixed match timer.

Absolute wall-clock time should be shown **only** as a secondary label, derived via
`to_datetime(ts_raw, unit="s")`, and presented as UTC with the caveat that the file declares no
timezone.

---

## 10. Match structure

| Metric | files | journeys | humans | bots |
|---|---:|---:|---:|---:|
| mean | 1.56 | 1.56 | 1.00 | 0.56 |
| median | 1.00 | 1.00 | 1.00 | 0.00 |
| max | 16.00 | 16.00 | **2** | **14** |

Distribution of journeys per match:

| Journeys | 1 | 2 | 5 | 7 | 8 | 12 | 14 | 15 | 16 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Matches | **743** | 1 | 2 | 24 | 8 | 4 | 4 | 9 | 1 |

- Matches with **exactly one journey: 743 of 796 (93.3%)**
- Matches with zero humans: **0** · Matches with zero bots: **744**
- Maximum humans in any match: **2**

The README's "a match with 10 humans and 40 bots produces 50 files" does not describe this drop.
**A full match roster cannot be reconstructed for 93% of matches** — this is a sampled export of
individual journeys, not a complete match log.

---

## 11. Journey shape and duration

Per journey (duration in seconds under the §9f hypothesis):

| | rows | movement samples | duration (s) |
|---|---:|---:|---:|
| min | 2 | 1 | 13 |
| 5% | 16 | 15 | 90 |
| median | 61 | 52 | **306** |
| 95% | 159 | 121 | 739 |
| max | 294 | 220 | **890** |

Medians by actor type:

| Actor | rows | samples | duration (s) |
|---|---:|---:|---:|
| human | 75.5 | 58.5 | 364.5 |
| bot | 40.5 | 39.0 | 220.5 |

**Edge cases:** 0 journeys with no movement sample; **3 journeys with exactly one** movement
sample (no path can be drawn); 0 journeys with zero duration.

Sampling cadence: modal interval exactly **5.0 s**, p95 = 10 s, p99 = 25 s, **max gap 518 s**.
Long gaps exist and must not be rendered as straight-line travel.

**Death accounting:** 739 of 1,242 journeys (59.5%) contain a death event — 736 with exactly one,
**3 with two**, which is internally inconsistent for a single life.

> **Dangerous to assume:** the remaining 40.5% "extracted". **No `Extract`, survival, or
> match-end event exists in the vocabulary.** The absence of a death event is equally consistent
> with successful extraction, telemetry truncation, or disconnection. Extraction rate is **not
> measurable** from this dataset.

---

## 12. Dates and volume

Under the seconds reading, the data covers **6** calendar dates, not the 5 the README claims:

| Date | Rows | Matches | Journeys |
|---|---:|---:|---:|
| 2026-02-09 | 14 | 1 | 1 |
| 2026-02-10 | 34,095 | 288 | 446 |
| 2026-02-11 | 20,813 | 199 | 285 |
| 2026-02-12 | 18,429 | 162 | 268 |
| 2026-02-13 | 11,106 | 112 | 166 |
| 2026-02-14 | 4,647 | 37 | 79 |

Matches per map per date:

| Date | AmbroseValley | GrandRift | Lockdown |
|---|---:|---:|---:|
| 2026-02-09 | 1 | 0 | 0 |
| 2026-02-10 | 202 | 24 | 62 |
| 2026-02-11 | 137 | 13 | 49 |
| 2026-02-12 | 127 | 9 | 26 |
| 2026-02-13 | 78 | 5 | 29 |
| 2026-02-14 | 24 | 8 | 5 |

Volume declines monotonically from Feb 10 to Feb 13; Feb 14 is a partial day, as documented.

> **Dangerous to assume** this decline reflects player behaviour. It is equally consistent with
> a sampling or export artefact, and nothing in the data distinguishes the two.

---

## 13. README claim verification

| # | README claim | Holds | Measured |
|---|---|---|---|
| 1 | Total files = 1,243 | **YES** | 1,243 readable |
| 2 | Total event rows ≈ 89,000 | **YES** | 89,104 |
| 3 | Unique players = 339 | **YES** | 339 |
| 4 | Unique matches = 796 | **YES** | 796 |
| 5 | 3 maps | **YES** | AmbroseValley, GrandRift, Lockdown |
| 6 | 8 event types | **YES** | 8 |
| 7 | `event` stored as bytes | **YES** | `binary`, no String annotation |
| 8 | One user / one match per file | **YES** | 0 violations in 1,243 files |
| 9 | Projection constants map onto the minimap | **YES** | 100.00% inside [0,1]² |
| 10 | Position events are ~85%+ of rows | **NO** | 82.0% |
| 11 | Minimaps are 1024×1024 | **NO** | 4320², 2160×2158, 9000² |
| 12 | `ts` is elapsed-within-match, not wall clock | **NO** | 0 of 1,242 journeys start near 0 |
| 13 | A match produces many files (e.g. 50) | **NO** | 93.3% of matches have exactly 1 |
| 14 | Bots emit only `BotPosition`/`BotKill`/`BotKilled` | **NO** *(as an id rule)* | 751 rows violate it |
| 15 | Humans have UUID ids; numeric ids are bots | **NO** | 17 journeys contradict it |
| 16 | 5 days of data (Feb 10–14) | **NO** | 6 dates; earliest 2026-02-09 23:58:55 |

Claim 14 deserves precision: as a statement about **event semantics** it is correct — journeys
that emit `BotPosition` emit nothing else but `BotKill`/`BotKilled`. It fails only as a statement
about **id format**.

---

## 14. Summary

### Confirmed

- **1,243 files, all readable, zero malformed, zero empty.** One identical schema across all.
- **89,104 rows**, **zero** nulls, NaNs, Infs or empty strings anywhere.
- **339 users, 796 matches, 1,242 journeys, 3 maps, 8 event types.**
- Filenames agree with file contents in **all 1,243 cases**.
- `ts` is physically **INT64** with logical type
  **`Timestamp(isAdjustedToUTC=false, timeUnit=milliseconds)`**, raw range
  **1,770,681,535 – 1,771,081,300**, granularity **1 raw unit**.
- Journeys do **not** start near zero — `ts` is not match-elapsed time.
- Co-match journeys share one clock: **53/53** multi-journey matches overlap, start spread ≤ 5.
- Projection constants are correct: **100.00%** of points land inside [0,1]² UV.
- Movement vocabulary partitions journeys **totally and exclusively** (798 human / 444 bot, 0
  both, 0 neither); the bot cohort emits **zero** human-only events.
- The id-format rule contradicts vocabulary on **17 journeys**; `user_id 1429` occupies both
  classes, so id is not a stable actor property.
- One **byte-identical duplicated file**; **1,417** exact duplicate rows (87% `Loot`); the coarse
  dedupe key would destroy **86 real events**.
- **93.3%** of matches contain exactly one journey; max humans per match is **2**.
- Human-vs-human combat totals **6 rows** across the entire dataset.
- Minimaps are **not** 1024×1024, and GrandRift is **not square**.
- The day folder misfiles **436 rows across 5 matches**; UTC+0 is the best-fitting bucket boundary.

### Ambiguous

- **The `ts` unit.** Overwhelmingly supported as seconds (§9f), but an inference about writer
  intent, not a stored fact. All relative-time work is built to be correct even if the absolute
  epoch interpretation is wrong.
- **Bit-identical duplicate `Loot` rows.** With 1-second granularity, a stationary double-pickup
  and a double-write are indistinguishable. Affects up to 9.6% of loot volume — but not loot
  *geometry*, since both readings place the event at the same coordinates.
- **What the paired `Kill`+`Killed` rows mean.** All 3 pairs share one actor, position and
  timestamp. Whether this is one death recorded twice, a killer-and-victim pair collapsed onto
  one row, or something else **cannot be determined**. n = 3; no conclusion should rest on it.
- **The true identity of the 17 conflicting journeys.** They loot (median 4) where real bots never
  do, so they behave like humans — but whether they are humans with legacy numeric ids or
  mislabelled bots is unknowable here.
- **Minimap orientation.** The v-flip in the README's formula is **unverified**; in-bounds
  coverage cannot distinguish it from three other orientations.
- **Unvisited map area.** Whether low-coverage regions are unplayable geometry or genuinely
  ignored space is not determinable from telemetry alone.

### Dangerous to assume

1. **That `ts` decodes correctly with its declared unit.** It does not. Any tool trusting the
   Parquet logical type places this data in **1970** and computes **0.31-second matches**. Read
   the INT64 payload directly.
2. **That the day folder is the event date.** It misfiles 436 rows across 5 matches. Derive dates
   from `ts`.
3. **That a full match roster can be reconstructed.** 93.3% of matches contain a single journey.
   A "match view" will usually show one player, and any per-match aggregate (kills per match,
   survivors) is computed over a **sample of unknown completeness**, not a roster.
4. **That absence of a death event means extraction.** There is no extraction event in this
   dataset. Extraction rate is not measurable.
5. **That `user_id` format identifies bots.** It is wrong for 17 journeys, and one id occupies
   both classes.
6. **That in-bounds UV validates the projection.** It validates scale and origin only. Orientation
   requires visual confirmation before any screenshot is trusted.
7. **That PvP statistics are meaningful.** 3 `Kill` events across 796 matches cannot support any
   claim about player-versus-player behaviour beyond "it is essentially absent here".
8. **That the declining daily volume is a player-behaviour signal.** Export artefact and genuine
   decline are indistinguishable in this data.
9. **That deduplication is cosmetic.** Choosing the obvious coarse key silently deletes 86 real
   events; choosing to skip dedupe inflates loot by ~9.6%.
10. **That the minimaps are 1024×1024 or square.** They are 4320²/2160×2158/9000², totalling
    23 MiB — both a correctness and a page-weight concern.
