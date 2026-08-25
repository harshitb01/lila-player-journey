# Data Quality Decisions

Two decisions taken before implementation, each validated against all 1,243 delivered files
(89,104 rows). Every figure below is reproducible via `scripts/validate_data_quality.py`.

The dataset README is treated as a hypothesis, not as fact. Where measurement contradicts it,
measurement wins and the contradiction is documented rather than silently absorbed.

---

## Decision 1 — Duplicate rows

### 1a. Precursor: one duplicated *file*

`cfa03e9f-81f6-41ef-a0fa-30c7e830f4ed_ac049b28-8116-4ff1-9e60-4be0537b8cc9.nakama-0` exists in
**both** `February_10/` and `February_11/`, byte-identical (88 rows each, verified by frame
equality). It is one journey delivered twice, not two journeys.

This must be resolved **before** row-level dedupe, otherwise the journey count is wrong (1,243
vs the true 1,242) and the day-folder label is ambiguous for that journey.

**Decision:** deduplicate at file level by journey key `(user_id, match_id)`, keeping the first
occurrence. Derive the calendar date from `ts`, **not** from the day-folder name — the folder is
demonstrably unreliable for this journey, and separately a `February_10/` match actually starts
at `2026-02-09 23:58:55`.

### 1b. Definition of an exact duplicate

> **Exact duplicate** := two rows with identical values in **all eight** data columns —
> `user_id, match_id, map_id, x, y, z, ts, event`.
>
> `x/y/z` are float32 and compared **bitwise-equal**, not with a tolerance. Metadata added by the
> loader (source folder, filename) is excluded from the key.

### Evidence

**Duplicates are not confined to `Loot`, but are heavily concentrated there** (counts after
file-level dedupe):

| event | raw | duplicates removed | deduped | dup % | share of all dups |
|---|---:|---:|---:|---:|---:|
| `Loot` | 12,866 | 1,234 | 11,632 | 9.59% | 87.1% |
| `Position` | 51,284 | 147 | 51,137 | 0.29% | 10.4% |
| `BotKill` | 2,410 | 34 | 2,376 | 1.41% | 2.4% |
| `BotKilled` | 699 | 2 | 697 | 0.29% | 0.1% |
| `BotPosition` | 21,712 | 0 | 21,712 | 0% | 0% |
| `Kill` / `Killed` / `KilledByStorm` | 3 / 3 / 39 | 0 | unchanged | 0% | 0% |
| **total** | **89,016** | **1,417** | **87,599** | 1.59% | 100% |

**Row-count reconciliation:** 89,104 delivered → −88 (duplicate file) → 89,016 → −1,417 (exact
duplicate rows) → **87,599 canonical rows across 1,242 journeys**.

**These are true exact duplicates, not repeated events with differing fields.** Grouping by
`(user_id, match_id, ts, event)` finds 1,355 multi-row groups covering 2,858 rows. Of these:

- 1,272 groups (2,683 rows) have **identical** coordinates → genuine exact duplicates.
- **83 groups (175 rows) have *different* coordinates** → distinct events sharing one timestamp
  (68 `Loot`, 15 `BotKill`). Example: two `Loot` rows in the same second, 0.14 world units apart.

**The duplication is systemic, not incidental.** The `Loot` duplication rate is stable across all
five days (8.4%–10.4%) and affects **441 of the 738 journeys that contain loot (60%)**.
Multiplicity of identical `Loot` rows reaches **7**.

**Critical constraint — `ts` resolution is 1 second.** The column contains integer epoch seconds
(zero sub-second values across 89,016 rows). Two genuinely distinct events less than a second
apart at an unchanged position are therefore *physically indistinguishable* from a double-write.
This ambiguity cannot be resolved from the data.

### Decision

1. **Deduplicate globally**, across all event types, using the strict all-eight-column key.
2. Retain raw counts alongside deduped counts in the pipeline manifest and expose the delta in
   the UI's data-quality panel. Never quote an absolute event total without stating its basis.

### Rationale

- **Global, not `Loot`-only.** An exact duplicate row carries zero independent information
  regardless of event type — it cannot serve as evidence of a second event. A type-specific rule
  would leave 183 known-duplicate rows in `Position`/`BotKill`/`BotKilled` for no principled
  reason, and would need re-litigating for every event type added later. Global is simpler,
  uniform, and defensible.
- **The strict key is provably the safe one.** The coarser key `(user_id, match_id, ts, event)`
  removes 1,503 rows — **86 more than the strict key** — and those 86 rows are exactly the
  distinct-coordinate events identified above. Choosing the strict key **preserves 86 real
  events** that a naive dedupe would destroy. This is the single most important detail in the
  decision.
- **Bitwise-identical float32 position is a strong duplicate signal.** The data proves the game
  *does* emit multiple real events within one timestamp second — and when it does, the position
  differs at float32 precision. Rows where the position is bit-identical are therefore more
  consistent with a re-emitted record than with two independently sampled events.
- **Honest limit:** looting is precisely when a player stands still, so a genuinely stationary
  double-pickup would also produce bit-identical rows. The 1-second resolution means this cannot
  be settled from the data. The decision is taken on balance of evidence, and raw counts are
  preserved so the choice stays reversible.

### Potential consequences

| Risk | Assessment |
|---|---|
| Loot volume understated by up to 9.6% if the duplicates are real pickups | Accepted and documented. Raw counts retained, so any downstream figure can be restated. |
| Loot heatmap intensity shifts | **Low impact.** Both interpretations place events at the *same coordinates*, so heatmap **geometry is unchanged** — only intensity scales. Hotspot ranking is robust either way. |
| Per-journey "items looted" metric changes | Affects 441 journeys. Both bases reported. |
| Under-deduplication if the game re-emits with jittered coordinates | Not observed — the 83 differing-coordinate groups are consistent with real distinct events, not jitter. |

### To document in ARCHITECTURE.md (assumptions section, 2–3 lines)

> Exact duplicate rows (all 8 columns identical) are removed globally: 89,104 → 87,599 rows, 87%
> of removals being `Loot`. A strict all-column key is used deliberately — a coarser
> `(user, match, ts, event)` key would delete 86 genuinely distinct events that share a
> timestamp, because `ts` resolution is only 1 second. Raw and deduped counts are both retained.
> One byte-identical file shipped in two day folders, so 1,243 files = 1,242 journeys.

---

## Decision 2 — Bot classification

### Evidence

**The README's rule** — UUID `user_id` = human, numeric `user_id` = bot — **and the event
vocabulary disagree.**

**Which events actually discriminate?** Not the ones the README implies:

| | `BotKill` | `BotKilled` | `BotPosition` | `Kill` | `Killed` | `KilledByStorm` | `Loot` | `Position` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| numeric id | 183 | 297 | 21,712 | 0 | 0 | 0 | 115 | 636 |
| uuid id | 2,227 | 402 | 0 | 3 | 3 | 39 | 12,751 | 50,648 |

`Loot`, `BotKill` and `BotKilled` are emitted under **both** id formats, so they are not
discriminative. Only `Position` vs `BotPosition` are.

**Event vocabulary is 100% internally consistent — verified, not assumed.** At journey level
(`user_id` + `match_id`):

| | has `BotPosition` = False | has `BotPosition` = True |
|---|---:|---:|
| **has `Position` = False** | 0 | 444 |
| **has `Position` = True** | 798 | 0 |

**0 journeys have both. 0 journeys have neither.** Across all 1,242 journeys this is a total,
mutually exclusive partition.

Stronger still, the partition is *behaviourally* pure: the 444 `BotPosition` journeys emit
**only** `BotPosition` (21,712), `BotKilled` (296) and `BotKill` (170) — **zero** `Loot`, `Kill`,
`Killed` or `KilledByStorm`. This is exactly the bot behaviour the README describes. **The
README's event semantics are correct; only its id-format rule is wrong.**

### The 17 disagreements

All 17 run in one direction — **numeric id emitting human vocabulary**. Zero UUID journeys emit
`BotPosition`. They involve only **three** user_ids:

| user_id | journeys | human-vocabulary | bot-vocabulary | map | days |
|---|---:|---:|---:|---|---|
| `1379` | 2 | 2 | 0 | GrandRift | Feb 14 |
| `1402` | 1 | 1 | 0 | Lockdown | Feb 12 |
| `1429` | 17 | **14** | **3** | AmbroseValley | Feb 10–14 |

Full journey list, with event breakdown:

| user_id | match_id (prefix) | map | day | rows | `Position` | `Loot` | `BotKill` | `BotKilled` |
|---|---|---|---|---:|---:|---:|---:|---:|
| 1379 | `14a40253` | GrandRift | Feb 14 | 7 | 6 | 1 | 0 | 0 |
| 1379 | `2cc08f74` | GrandRift | Feb 14 | 20 | 17 | 3 | 0 | 0 |
| 1402 | `6edefa1c` | Lockdown | Feb 12 | 26 | 26 | 0 | 0 | 0 |
| 1429 | `41d4555d` | AmbroseValley | Feb 10 | 72 | 67 | 4 | 0 | 1 |
| 1429 | `50192a5f` | AmbroseValley | Feb 10 | 10 | 8 | 2 | 0 | 0 |
| 1429 | `56e214f3` | AmbroseValley | Feb 10 | 71 | 58 | 13 | 0 | 0 |
| 1429 | `5def8d6b` | AmbroseValley | Feb 10 | 55 | 40 | 14 | 1 | 0 |
| 1429 | `159f75f9` | AmbroseValley | Feb 11 | 22 | 21 | 1 | 0 | 0 |
| 1429 | `a81cca92` | AmbroseValley | Feb 11 | 31 | 26 | 5 | 0 | 0 |
| 1429 | `8a1e376c` | AmbroseValley | Feb 12 | 4 | 4 | 0 | 0 | 0 |
| 1429 | `de5aa1ae` | AmbroseValley | Feb 12 | 152 | 120 | 28 | 4 | 0 |
| 1429 | `ec57f6ca` | AmbroseValley | Feb 12 | 51 | 42 | 7 | 2 | 0 |
| 1429 | `fbbc5d02` | AmbroseValley | Feb 12 | 34 | 27 | 7 | 0 | 0 |
| 1429 | `16f9df84` | AmbroseValley | Feb 13 | 85 | 72 | 13 | 0 | 0 |
| 1429 | `8bb25783` | AmbroseValley | Feb 13 | 2 | 2 | 0 | 0 | 0 |
| 1429 | `3731eba6` | AmbroseValley | Feb 14 | 29 | 26 | 2 | 1 | 0 |
| 1429 | `6eb15857` | AmbroseValley | Feb 14 | 94 | 74 | 15 | 5 | 0 |
| | | | **total** | **765** | **636** | **115** | **13** | **1** |

These 765 rows carry **all 115** of the `Loot` rows and **all 636** of the `Position` rows
attributed to numeric ids — i.e. every "bot doing human things" row in the dataset comes from
this set. Removing it leaves the bot cohort perfectly clean.

**`user_id 1429` appears as human in 14 matches and as a bot in 3.** An id is therefore not a
stable property of an actor, which is decisive: no id-based rule can be correct here.

**Behavioural profile** (median per journey):

| cohort | n | rows | duration (s) | loot |
|---|---:|---:|---:|---:|
| uuid + human vocabulary | 781 | 77.0 | 367.0 | 14.0 |
| **numeric + human vocabulary** | **17** | **31.0** | **161.0** | **4.0** |
| bot vocabulary | 444 | 40.5 | 220.5 | **0.0** |

The 17 loot (median 4); true bot-vocabulary journeys never loot (median 0, and 0 in total).
Behaviourally they sit closer to humans, on shorter sessions.

### Decision

**Operational rule — classify per journey by movement vocabulary:**

> `actor_type = "bot"` if the journey contains a `BotPosition` event, else `"human"`.
> Result: **444 bots, 798 humans.**

Classification is a property of the **journey** (`user_id` + `match_id`), never of the `user_id`,
because id `1429` demonstrably switches between them.

**The alternative classification is preserved, not discarded.** Every journey record carries:

| field | values | meaning |
|---|---|---|
| `actor_type` | `human` \| `bot` | operational classification (movement vocabulary) |
| `id_format` | `uuid` \| `numeric` | the README's rule, retained verbatim as a validation field |
| `actor_id_conflict` | boolean | `true` for the 17 journeys where the two disagree |

Nothing is lost: any consumer can reconstruct the README's classification exactly from
`id_format`, and can isolate or exclude the disputed 17 via `actor_id_conflict`.

### Rationale

- Event vocabulary is a **verified total partition** with zero contradictions across 1,242
  journeys; the id rule has 17 counterexamples.
- Vocabulary is **behaviourally coherent** — bot-vocabulary journeys never loot, never die to the
  storm, never engage in PvP, matching the README's own description of bot behaviour.
- Id format **cannot** be correct, since one id occupies both classes.
- A binary `actor_type` (rather than a third "ambiguous" bucket) keeps the UI legible for a Level
  Designer; the 1.37% of disputed journeys are surfaced by a badge and a data-quality counter
  instead of fragmenting the primary filter.

### Potential consequences

| Risk | Assessment |
|---|---|
| The 17 are really bots with a telemetry defect, so bot paths get drawn as human | Max impact 765 rows = **0.87%** of the dataset, 1.37% of journeys. Isolable at any time via `actor_id_conflict`. |
| An evaluator applies the README's rule and gets different totals | Mitigated by shipping `id_format` and stating both counts explicitly (798 vs 781 humans). |
| Rule breaks if a future journey has neither movement event | Guarded: the pipeline asserts the partition is total and fails the build if any journey has both or neither. |
| Bot cohort contaminated | Not a risk under this rule — the bot cohort is provably pure (zero human-only events). |

### To document in ARCHITECTURE.md (assumptions section, 2–3 lines)

> Bots are classified per journey by movement vocabulary (`BotPosition` ⇒ bot), not by the
> README's UUID-vs-numeric id rule. Vocabulary is a verified total partition (798 human / 444
> bot; 0 journeys with both or neither) and bot journeys never loot; the id rule has 17
> counterexamples, and `user_id 1429` appears as human in 14 matches and bot in 3, so id is not a
> stable actor property. The id-based value is retained as `id_format` with an
> `actor_id_conflict` flag so the README's classification stays reconstructible.

---

## Summary

| | Decision | Scale of effect | Reversible? |
|---|---|---|---|
| **Duplicates** | Global exact-row dedupe on all 8 columns, after file-level dedupe | 1,505 rows removed (1.7%); 89,104 → 87,599 | Yes — raw counts retained |
| **Bots** | Per-journey movement vocabulary; id preserved as validation field | 17 journeys reclassified (1.37%) | Yes — `id_format` retained |

Both decisions favour the interpretation supported by measurement, keep the discarded alternative
as data, and fail loudly in the pipeline if their assumptions stop holding.
