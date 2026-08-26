# Insights

These three observations are descriptive, not causal. Every numeric claim below is
printed directly by `python scripts/analyze_insights.py`, which reads only the committed
processed dataset in `public/data/` (87,599 rows, 1,242 journeys, 796 matches, 3 maps).
The script also prints the underlying counts so rounded percentages can be checked.

## 1. Loot pickup samples are less common in the final match quarter

Of 11,632 deduplicated `Loot` events, the match-relative distribution is:

| Match quarter | Loot events | Share |
| --- | ---: | ---: |
| Q1 | 3,151 | 27.1% |
| Q2 | 3,385 | 29.1% |
| Q3 | 3,070 | 26.4% |
| Q4 | 2,026 | 17.4% |

The first three quarters are close to or above a 25% uniform-time reference; Q4 is 7.6
percentage points below it. Movement samples also decline over the match, but less
sharply: the script reports 20.5% of movement samples in Q4.

### Why it may matter

Late-match loot placement may receive fewer pickup interactions than placement earlier
in the match. This is useful context for a designer reviewing late-match item placement
or pacing.

### Caveats

- The data records pickups, not available loot spawns. A lower pickup count can mean
  lower supply, different player priorities, match endings, or another unobserved cause.
- Quartiles are normalized by match duration; they are not equal real-time windows
  across matches.
- The counts do not establish that a design change is needed. Spawn and inventory data
  would be required to distinguish availability from player choice.

## 2. Bot-classified journeys contain no recorded loot pickups

The movement-vocabulary classification used by the app identifies 444 bot journeys and
798 human journeys. The script reports:

- Bot journeys with loot: 0.0% (0 of 444); median 0; mean 0.
- Human journeys with loot: 92.48% (738 of 798); median 12; mean 14.58.

This is a complete zero in the processed sample, not merely a lower bot pickup rate.

### Why it may matter

If bots are expected to participate in the loot system, this is a clear behavior to
confirm with the gameplay/AI team. If bots intentionally do not loot, the result is a
useful statement of the current telemetry baseline.

### Caveats

- The observation uses the app's movement-vocabulary actor classification. The dataset
  contains 17 journeys where movement vocabulary and identifier format disagree.
- Telemetry shows that no `Loot` event was recorded on bot-classified journeys. It
  cannot determine whether that behavior is intended or whether bots receive equipment
  through another system.

## 3. Recorded movement is spatially concentrated

Using the script's fixed 20×20 UV grid, the 40 busiest cells (10% of all cells) contain:

| Map | Movement samples | Occupied cells | Share in busiest 40 cells |
| --- | ---: | ---: | ---: |
| Ambrose Valley | 48,581 | 182 | 58.0% |
| Grand Rift | 5,728 | 163 | 57.7% |
| Lockdown | 18,540 | 145 | 65.5% |

The same script separately measures a 16×16 grid restricted to each map's observed
telemetry envelope. Cells with zero recorded movement comprise 21.1% of that envelope
on Ambrose Valley, 26.2% on Grand Rift, and 28.1% on Lockdown.

### Why it may matter

The concentration identifies a small set of areas worth inspecting in the map editor
for routes, objectives, cover, and convergence. The app's movement-sample and Low
Activity overlays make those patterns visible for a selected cohort.

### Caveats

- Sample density is not literal time spent. It is the count of recorded movement
  samples under the telemetry's sampling behavior.
- A zero-sample cell is not proof of player avoidance or playable terrain. The
  observed envelope is a rectangular telemetry bound and can include inaccessible
  geometry.
- Grid size changes the exact shares, and Grand Rift has a substantially smaller
  sample than the other maps.

## Reproduce

```bash
python scripts/analyze_insights.py
```

Relevant output sections are `2. PLAYER TRAFFIC`, `7. BOT / HUMAN BEHAVIOUR`,
`8. MATCH PROGRESSION`, and `9. LOW-ACTIVITY CELLS WITHIN THE OBSERVED PLAY ENVELOPE`.
