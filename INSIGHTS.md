# Insights

Three insights, selected from eight candidates after a skeptical adversarial review that
checked each for sample-size issues, map/actor imbalance, partial-day distortion,
confounded denominators, and selection bias. Five candidates were rejected or
significantly weakened during that review; these three survived every check applied.
All figures are computed directly from the processed dataset
(`public/data/`, 87,599 rows / 1,242 journeys / 796 matches / 3 maps) via
`scripts/analyze_insights.py`. None of these claims establish *why* — only *what was
observed*, at the stated sample size.

---

# Loot pickups drop sharply in the match's final quarter

## What caught our attention

Loot pickup activity is roughly even across the first three quarters of a match, then
falls off sharply in the last quarter — not a gradual taper, a step down.

## Evidence

- Loot events by match-relative quartile (n = 11,632 deduplicated pickups):
  **Q1 27.1% · Q2 29.1% · Q3 26.4% · Q4 17.4%**, against a 25.0% uniform-time baseline.
  Q4 sits 7.6 percentage points below baseline — the largest deviation of any quartile,
  and the only one that's clearly outside noise.
- Holds independently on all three maps: Q4 share is 17.2% (Ambrose, n=8,988), 21.4%
  (Grand Rift, n=753), 16.9% (Lockdown, n=1,891).
- Holds across match-length terciles (short/medium/long, split at the 33rd/66th
  percentile of match duration): Q4 share is 15.6%, 19.8%, and 16.4% respectively — not
  an artifact of short matches ending before players get to loot.
- Holds in both single-journey matches (95.2% of the loot sample, Q4=17.7%) and
  multi-journey matches (4.8%, Q4=12.5%, if anything more pronounced).
- Only 6.4% of loot events are the last recorded event of their own journey, which rules
  out a measurement artifact seen elsewhere in this analysis (an event that always ends
  its own journey trivially inherits 100% "final quarter" placement regardless of any
  real pattern — loot is not exposed to that trap).

## Why it matters

Loot is the game's item-acquisition loop. If pickups fall off in the last quarter across
every map and every match length, whatever is placed there — value-tier upgrades,
late-drop caches, comeback items — is being engaged with at roughly two-thirds the rate
of the rest of the match. A Level Designer tuning late-game pacing should know this
before assuming late loot is landing the way it was intended to.

## Action

- Cross-reference against loot **spawn** timing and density in the final quarter — this
  dataset shows pickups, not availability; if spawns are just as dense late as early,
  the gap is a player-behavior story, not a supply one.
- Review what's actually placed in the zones players occupy during Q4 (see the traffic
  hotspot insight below — these are frequently the same late-journey locations). If
  high-value loot sits there expecting a Q4 audience, engagement data says fewer players
  are stopping for it than the design may assume.
- Consider a small, testable intervention (clearer pickup affordance, a directed prompt,
  or repositioning late loot nearer to convergence zones) and re-measure the same
  quartile split afterward.

## Metrics to watch

Loot pickup rate by match-quartile (the metric this insight is built on — track it as a
baseline going forward); loot-spawn-to-pickup conversion rate if spawn telemetry becomes
available; storm-death and kill rate in Q4 (a competing draw on player attention worth
ruling in or out); average items held at match end.

## Caveats

- This measures **pickups**, not loot **availability** — a real drop-off is equally
  consistent with "there's nothing left to loot" and "players are too busy
  fighting/fleeing the storm to stop." This dataset cannot separate the two; spawn-side
  data would be needed to.
- Quartiles are match-relative (Q4 of a 200-second match and Q4 of an 800-second match
  are very different durations in real time), though the pattern held independently
  when matches were bucketed by absolute duration.
- 95.2% of the underlying sample comes from matches where only one journey was
  captured — this predominantly describes solo/duo play, not large-lobby dynamics,
  though the smaller multi-journey subset shows the same pattern, not a different one.

---

# Bots never interact with the loot economy

## What caught our attention

Not "bots loot less than humans" — bots loot **never**. Zero out of 444 bot journeys
record a single `Loot` event, in a dataset where humans pick up loot in the large
majority of their journeys.

## Evidence

- 0/444 bot journeys (0.0000%) contain any `Loot` event, versus 738/798 human journeys
  (92.48%). Median loot count: bots 0, humans 12 (mean 14.6).
- Robust to classification method: under the dataset documentation's alternate
  UUID-vs-numeric-id rule (rather than the movement-vocabulary rule used operationally
  in this tool), bot loot participation rises only to 3.0% (14/461). Those 14 are drawn
  entirely from the 17 already-known id-format exceptions that behave like humans in
  every other respect (14 of those 17 loot; the true bot-vocabulary population remains
  0/444) — not a broader pattern of bots looting.
- Robust to exposure time: restricting to the 23 longest-lived bot journeys (523–790
  seconds, up to 148 position samples — more samples than the median *human* journey's
  58) still shows 0/23 with any loot. Short session length cannot explain this result.

## Why it matters

Loot is a core power-progression mechanic. If bots categorically cannot pick it up, any
tuning that assumes bot difficulty scales with map loot density — or that a
well-equipped human should have an edge over bots specifically because of gear — rests
on an assumption this data contradicts entirely for the bot side.

## Action

- Confirm with the AI/systems team whether this is intended (bots are combat-scripted
  and not meant to interact with items) or an unshipped/incomplete behavior. A 0%
  result this clean, with exposure ruled out, is either fully by design or a real gap —
  it's unlikely to be noise.
- If bot difficulty is meant to track loot-driven player power, that tuning currently
  has no lever on the bot side — difficulty adjustments there have to come from bot
  stats/spawns directly, not from loot placement.
- If bots are expected to eventually interact with loot (a roadmap feature), this is a
  clean baseline to measure against once that ships.

## Metrics to watch

Bot difficulty/kill-participation rate relative to map loot density (currently
decoupled, per this finding); human vs. bot combat outcome rates if loot-driven human
power is a deliberate balance lever; any player-facing perception metrics around "bots
feel unfair/too easy" that a designer might otherwise mistakenly attribute to loot
imbalance.

## Caveats

- This is drawn from the movement-vocabulary actor classification (verified as an
  internally consistent, total partition earlier in this analysis), not the dataset
  documentation's stated id-format rule. The two disagree on 17 journeys, but neither
  reclassification meaningfully changes the result.
- The data shows bots do not **pick up** loot. It says nothing about whether bot combat
  stats or equipment are influenced by nearby loot through some other system not
  captured in this telemetry.
- Behavior, not intent: this dataset can show bots never loot; it cannot show whether
  that is a deliberate design choice or an incomplete feature.

---

# The busiest point on the map is a late-journey destination, not the spawn

## What caught our attention

The single most-visited location on every map was expected to be a spawn cluster or a
central crossroads. It's neither — it's a specific location that players and bots
overwhelmingly reach near the **end** of their own journey, not the beginning.

## Evidence

- On Ambrose Valley, the busiest 20×20-grid cell (of 400) alone accounts for 1,520 of
  48,581 traffic samples (3.13%); the top 10% of cells (40 of 400) account for
  28,155/48,581 = **58.0%** of all traffic, against a 10% uniform-density baseline.
  Similar concentration holds on Grand Rift (57.7% of 5,728) and Lockdown (65.5% of
  18,540).
- Not one player camping: the top Ambrose cell is visited by 195 distinct journeys; the
  single busiest journey there contributes only 2.0% of that cell's traffic. Both bots
  (778 samples) and humans (742) pass through it. No single day accounts for more than
  51% of any top cell's traffic across the five-plus days captured.
- Not the spawn: **0.0% of visits to the top cell occur within the first 15 seconds of
  a journey**, on every map.
- It is disproportionately a **late**-journey location: measuring each visit as a
  fraction of that specific journey's own start-to-end span (not match duration —
  this sidesteps a measurement trap that affected an earlier, discarded candidate),
  56.2% of visits to Ambrose's top cell fall in the player's own final quarter, and
  48.5% on Lockdown, against a 25% baseline. Grand Rift's top cell is more evenly
  spread (30.3% in the final quarter) — the pattern is clearest on the two larger-sample
  maps.

## Why it matters

Nearly every player's route converges on this one location, and they arrive there late
in their own session — when time pressure, whatever remains of the match's difficulty
curve, and (on an extraction-shooter design) any end-of-match mechanics are at their
peak. This dataset doesn't include health or combat-state telemetry, so "most
vulnerable" is not something we can measure directly — but "guaranteed high-traffic at
the latest point in the session" is measured, and that alone makes this the kind of
location a Level Designer wants to have deliberately shaped, not stumbled into.

## Action

- Pull the exact coordinates from this tool's Region Inspector or heatmap overlay and
  walk the location in the editor. Confirm what it actually is before treating this as
  either a success or a problem.
- If it's an intended extraction/objective zone: this is strong confirmation the funnel
  is working — worth a dedicated pass on sightlines, cover, and escape routes there,
  since congestion is concentrated exactly where players are most vulnerable.
- If it's not an intended objective: treat it as an unplanned chokepoint. Consider
  whether terrain is funneling players there unintentionally (a natural corridor, a
  storm-shape artifact, or a lack of alternate routes late in the match) and whether a
  secondary path would relieve it.
- Layer the kill/death heatmap over this same cell for the same late-journey window as
  a direct follow-up — this insight identifies *where and when* people converge, not
  whether that convergence is also where they die.

## Metrics to watch

Kill and death density at this specific location, isolated to the late-journey window
identified here; average time-to-extraction if this is an extraction zone; frame-time
or hitch metrics if player-count concentration at one point is a technical concern;
storm-boundary timing relative to this location on each map.

## Caveats

- This describes **where and when** players converge, not **why**. It does not
  distinguish "players are drawn here on their own" from "the storm or map geometry
  forces them here" — both produce the same telemetry signature.
- The late-journey framing is normalized to each journey's own duration specifically to
  avoid a match-duration measurement trap identified elsewhere in this analysis; it is
  not vulnerable to that trap, but it also cannot rule out that a *different* boundary
  definition would tell a different story.
- Grand Rift shows the same general concentration but a weaker late-journey signal —
  possibly a real map-layout difference, or simply its much smaller sample (5,728
  traffic points, an order of magnitude less than Ambrose Valley); this dataset can't
  distinguish the two.
