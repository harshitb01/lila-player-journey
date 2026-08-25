# LILA Player Journey

Analysis and level-design tooling built on player event telemetry from **LILA BLACK**, an
extraction shooter. The dataset covers 5 days of production gameplay (Feb 10-14, 2026):
~1,243 player-match journeys, ~89,000 events, 339 unique players across 796 matches on
3 maps (AmbroseValley, GrandRift, Lockdown).

## Project structure

```
lila-player-journey/
├── data/
│   └── raw/          # immutable source data — never edited in place
├── scripts/          # entry-point scripts (ETL, batch jobs, one-off analyses)
├── src/              # reusable library code imported by scripts
└── README.md
```

- **`data/raw/`** holds the untouched parquet journeys and minimap images exactly as
  exported. Nothing in the pipeline writes here.
- **`scripts/`** holds runnable top-level programs. Each script should be thin: parse
  arguments, call into `src/`, write output.
- **`src/`** holds the loading, transformation, and plotting logic. No side effects at
  import time.

## Data format

Journey files are Apache Parquet despite the `.nakama-0` extension, named
`{user_id}_{match_id}.nakama-0` — one file per player per match. UUID `user_id` values are
human players; short numeric ids are bots.

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | string | Player or bot identifier |
| `match_id` | string | Match identifier (with `.nakama-0` server suffix) |
| `map_id` | string | `AmbroseValley`, `GrandRift`, or `Lockdown` |
| `x` | float32 | World X coordinate |
| `y` | float32 | World Y (elevation — not a 2D map axis) |
| `z` | float32 | World Z coordinate |
| `ts` | timestamp (ms) | Time elapsed within the match |
| `event` | binary | Event type, stored as bytes — decode to UTF-8 |

Event types: `Position`, `BotPosition` (movement, ~85% of rows); `Kill`, `Killed`,
`BotKill`, `BotKilled` (combat); `KilledByStorm` (environment); `Loot` (items).

## World-to-minimap projection

Minimaps are 1024x1024. Plot with `x` and `z` only:

```
u = (x - origin_x) / scale
v = (z - origin_z) / scale
pixel_x = u * 1024
pixel_y = (1 - v) * 1024      # image origin is top-left
```

| Map | Scale | Origin X | Origin Z |
|-----|-------|----------|----------|
| AmbroseValley | 900 | -370 | -473 |
| GrandRift | 581 | -290 | -290 |
| Lockdown | 1000 | -500 | -500 |

See [player_data/README.md](player_data/README.md) for the full dataset reference.
