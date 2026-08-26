"""Game-analytics / level-design insight mining over the PROCESSED dataset only.

Reads exclusively from `public/data/` — the pipeline's output — never from
`data/raw/`. Every number in this report is computed fresh here; nothing is carried
over from earlier analysis phases as an assumed fact.

Usage:
    python scripts/analyze_insights.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path("public/data")
pd.set_option("display.width", 140)
pd.set_option("display.max_columns", 20)


def load_json(name: str):
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


def section(title: str) -> None:
    print("\n" + "=" * 92)
    print(title)
    print("=" * 92)


# --------------------------------------------------------------------------------------
# Load and reconstruct — ONLY from public/data
# --------------------------------------------------------------------------------------

manifest = load_json("manifest.json")
maps_payload = load_json("maps.json")
index = load_json("index.json")

COORD_SCALE = manifest["coordinateScale"]
EVENT_NAMES = index["dictionaries"]["event"]
DATE_DICT = index["dictionaries"]["date"]
FOLDER_DICT = index["dictionaries"]["sourceFolder"]
MAP_DICT = index["dictionaries"]["mapId"]
ACTOR_DICT = index["dictionaries"]["actorType"]
IDFMT_DICT = index["dictionaries"]["idFormat"]
MATCH_SUFFIX = index["dictionaries"]["matchSuffix"]

MAP_CONFIG = {m["id"]: m for m in maps_payload["maps"]}

jc = index["journeys"]
journeys = pd.DataFrame({
    "journey_id": range(jc["count"]),
    "userId": jc["userId"],
    "match_idx": jc["match"],
    "date": [DATE_DICT[i] for i in jc["date"]],
    "sourceFolder": [FOLDER_DICT[i] for i in jc["sourceFolder"]],
    "actorType": [ACTOR_DICT[i] for i in jc["actorType"]],
    "idFormat": [IDFMT_DICT[i] for i in jc["idFormat"]],
    "actorIdConflict": jc["actorIdConflict"],
    "startTRel": jc["startTRel"],
    "journeyDurationSec": jc["durationSec"],
    "sampleCount": jc["sampleCount"],
})
event_counts = pd.DataFrame(jc["eventCounts"], columns=EVENT_NAMES)
journeys = pd.concat([journeys, event_counts], axis=1)

mc = index["matches"]
matches = pd.DataFrame({
    "match_idx": range(mc["count"]),
    "matchId": [m + MATCH_SUFFIX for m in mc["matchId"]],
    "mapId": [MAP_DICT[i] for i in mc["mapId"]],
    "startedAt": mc["startedAt"],
    "matchDurationSec": mc["durationSec"],
})

journeys = journeys.merge(matches, on="match_idx", how="left")
journeys["journey_key"] = journeys.journey_id  # index into tracks[].j

# --- points: every telemetry row, rebuilt from tracks/*.json only ---
frames = []
for map_id, cfg in MAP_CONFIG.items():
    payload = load_json(f"tracks/{map_id}.json")
    for track in payload["tracks"]:
        n = len(track["t"])
        if n == 0:
            continue
        frames.append(pd.DataFrame({
            "journey_id": track["j"],
            "map_id": map_id,
            "tRel": track["t"],
            "x": np.array(track["x"], dtype=np.float64) / COORD_SCALE,
            "z": np.array(track["z"], dtype=np.float64) / COORD_SCALE,
            "event_code": track["e"],
        }))
points = pd.concat(frames, ignore_index=True)
points["event"] = points.event_code.map(lambda c: EVENT_NAMES[c])

points = points.merge(
    journeys[["journey_id", "userId", "actorType", "date", "match_idx", "matchId",
              "matchDurationSec", "startedAt", "actorIdConflict"]],
    on="journey_id", how="left",
)

for map_id, cfg in MAP_CONFIG.items():
    proj = cfg["projection"]
    mask = points.map_id == map_id
    points.loc[mask, "u"] = (points.loc[mask, "x"] - proj["originX"]) / proj["scale"]
    points.loc[mask, "v"] = (points.loc[mask, "z"] - proj["originZ"]) / proj["scale"]

points["matchFrac"] = np.where(
    points.matchDurationSec > 0, points.tRel / points.matchDurationSec, np.nan
)

MOVEMENT = {"Position", "BotPosition"}
KILLS = {"Kill", "BotKill"}
DEATHS = {"Killed", "BotKilled"}
STORM = {"KilledByStorm"}
LOOT = {"Loot"}

# --------------------------------------------------------------------------------------
# 0. Integrity: prove this IS the processed dataset, completely and correctly read
# --------------------------------------------------------------------------------------

section("0. INTEGRITY CHECK AGAINST manifest.json / maps.json")
print(f"manifest.processed.rows      = {manifest['processed']['rows']:,}")
print(f"points rebuilt from tracks/*  = {len(points):,}")
print(f"match: {manifest['processed']['rows'] == len(points)}")
print(f"manifest.processed.journeys  = {manifest['processed']['journeys']:,}  "
      f"vs index.journeys.count = {jc['count']:,}")
print(f"manifest.processed.matches   = {manifest['processed']['matches']:,}  "
      f"vs index.matches.count  = {mc['count']:,}")

print("\nper-map row count, points table vs maps.json totals:")
chk = points.groupby("map_id").size().rename("points_rebuilt")
chk2 = pd.Series({m: c["totals"]["rows"] for m, c in MAP_CONFIG.items()}, name="maps_json_rows")
print(pd.concat([chk, chk2], axis=1))

print("\nUV bounds sanity (should be 100.00% inside [0,1] on every map):")
for map_id in MAP_CONFIG:
    sub = points[points.map_id == map_id]
    inb = sub.u.between(0, 1) & sub.v.between(0, 1)
    print(f"  {map_id:<14} {100*inb.mean():.4f}% in-bounds  (n={len(sub):,})")

# ========================================================================================
# 1. MAP USAGE
# ========================================================================================

section("1. MAP USAGE")
map_usage = journeys.groupby("mapId").agg(
    journeys=("journey_id", "size"),
    matches=("match_idx", "nunique"),
).reset_index()
total_journeys = len(journeys)
total_matches = matches.match_idx.nunique()
map_usage["pct_journeys"] = 100 * map_usage.journeys / total_journeys
map_usage["pct_matches"] = 100 * map_usage.matches / total_matches
print(map_usage.to_string(index=False))
print(f"\ntotals: {total_journeys} journeys, {total_matches} matches")
print(f"if usage were uniform across 3 maps, baseline share = {100/3:.2f}%")

# ========================================================================================
# 2. PLAYER TRAFFIC — spatial grid
# ========================================================================================

section("2. PLAYER TRAFFIC — spatial grid (traffic = Position + BotPosition)")

GRID_N = 20  # 20x20 = 400 cells; ~48.5k traffic pts on Ambrose -> ~120/cell average


def to_grid(sub: pd.DataFrame, n: int = GRID_N) -> pd.Series:
    col = np.clip((sub.u * n).astype(int), 0, n - 1)
    row = np.clip(((1 - sub.v) * n).astype(int), 0, n - 1)
    return row * n + col


traffic = points[points.event.isin(MOVEMENT)]
for map_id in MAP_CONFIG:
    sub = traffic[traffic.map_id == map_id]
    if len(sub) == 0:
        continue
    cell = to_grid(sub)
    counts = cell.value_counts()
    total = len(sub)
    occupied_cells = (counts > 0).sum()
    top10pct_n = max(1, int(np.ceil(0.10 * GRID_N * GRID_N)))
    top_share = counts.head(top10pct_n).sum() / total
    print(f"\n{map_id}: {total:,} traffic points, {GRID_N}x{GRID_N} grid "
          f"({GRID_N*GRID_N} cells), {occupied_cells} occupied")
    print(f"  top {top10pct_n} cells (10% of grid) hold "
          f"{counts.head(top10pct_n).sum():,}/{total:,} = {100*top_share:.1f}% of traffic")
    print(f"  top 5 cells:")
    for cell_id, n in counts.head(5).items():
        row, col = divmod(cell_id, GRID_N)
        u_c = (col + 0.5) / GRID_N
        v_c = 1 - (row + 0.5) / GRID_N
        print(f"    cell(row={row},col={col}) center uv=({u_c:.3f},{v_c:.3f})  "
              f"n={n:,}  {100*n/total:.2f}% of map traffic")

# ========================================================================================
# 3. COMBAT (kills)
# ========================================================================================

section("3. COMBAT — kills (Kill + BotKill)")
kills = points[points.event.isin(KILLS)]
print(f"total kill events (processed): {len(kills):,}")
print(kills.groupby(["map_id", "event"]).size().unstack(fill_value=0))
print(f"\nby actorType (whose JOURNEY the event is recorded on):")
print(kills.groupby(["actorType", "event"]).size().unstack(fill_value=0))

print("\nPvP vs PvE decomposition (dataset-wide):")
n_kill = (points.event == "Kill").sum()
n_botkill = (points.event == "BotKill").sum()
n_combat_kill_total = n_kill + n_botkill
print(f"  Kill (human-vs-human):   {n_kill}")
print(f"  BotKill (vs bot):        {n_botkill}")
print(f"  Kill / (Kill+BotKill) =  {n_kill}/{n_combat_kill_total} = "
      f"{100*n_kill/max(1,n_combat_kill_total):.2f}%")

GRID_C = 8
for map_id in MAP_CONFIG:
    sub = kills[kills.map_id == map_id]
    if len(sub) == 0:
        continue
    cell = to_grid(sub, GRID_C)
    counts = cell.value_counts()
    print(f"\n{map_id}: {len(sub)} kill events, {GRID_C}x{GRID_C} grid, "
          f"top cell holds {counts.iloc[0]}/{len(sub)} = {100*counts.iloc[0]/len(sub):.1f}%")

# ========================================================================================
# 4. DEATHS (non-storm: Killed + BotKilled)
# ========================================================================================

section("4. DEATHS — Killed + BotKilled (storm handled separately in §5)")
deaths = points[points.event.isin(DEATHS)]
print(f"total non-storm death events: {len(deaths):,}")
print(deaths.groupby(["map_id", "event"]).size().unstack(fill_value=0))
print(f"\nby actorType:")
print(deaths.groupby(["actorType", "event"]).size().unstack(fill_value=0))

for map_id in MAP_CONFIG:
    sub = deaths[deaths.map_id == map_id]
    if len(sub) == 0:
        continue
    cell = to_grid(sub, GRID_C)
    counts = cell.value_counts()
    print(f"\n{map_id}: {len(sub)} deaths, top cell {counts.iloc[0]}/{len(sub)} = "
          f"{100*counts.iloc[0]/len(sub):.1f}%  (top-5 cells sum = "
          f"{counts.head(5).sum()}/{len(sub)} = {100*counts.head(5).sum()/len(sub):.1f}%)")

# ========================================================================================
# 5. STORM DEATHS
# ========================================================================================

section("5. STORM DEATHS")
storm = points[points.event.isin(STORM)]
print(f"total storm deaths (processed): {len(storm)}")
print(storm.groupby("map_id").size())

for map_id in MAP_CONFIG:
    sub = storm[storm.map_id == map_id]
    if len(sub) == 0:
        continue
    print(f"\n{map_id}: n={len(sub)}")
    print(f"  u: min={sub.u.min():.3f} max={sub.u.max():.3f} mean={sub.u.mean():.3f}")
    print(f"  v: min={sub.v.min():.3f} max={sub.v.max():.3f} mean={sub.v.mean():.3f}")
    print(f"  matchFrac (position within match duration): "
          f"min={sub.matchFrac.min():.2f} mean={sub.matchFrac.mean():.2f} "
          f"max={sub.matchFrac.max():.2f}")

# ========================================================================================
# 6. LOOT
# ========================================================================================

section("6. LOOT")
loot = points[points.event.isin(LOOT)]
print(f"total loot events (processed, deduped): {len(loot):,}")
print(loot.groupby("map_id").size())

for map_id in MAP_CONFIG:
    sub = loot[loot.map_id == map_id]
    if len(sub) == 0:
        continue
    cell = to_grid(sub, GRID_N)
    counts = cell.value_counts()
    top10pct_n = max(1, int(np.ceil(0.10 * GRID_N * GRID_N)))
    print(f"{map_id}: n={len(sub):,}, top {top10pct_n} cells hold "
          f"{counts.head(top10pct_n).sum():,}/{len(sub):,} = "
          f"{100*counts.head(top10pct_n).sum()/len(sub):.1f}%")

# Cross-reference: traffic-weighted loot encounter rate per map
print("\nloot events per 1,000 traffic points, by map (a rough 'loot density' comparator):")
for map_id in MAP_CONFIG:
    t = (points.map_id == map_id) & points.event.isin(MOVEMENT)
    l = (points.map_id == map_id) & points.event.isin(LOOT)
    tn, ln = t.sum(), l.sum()
    print(f"  {map_id:<14} loot={ln:,} traffic={tn:,} -> {1000*ln/max(1,tn):.2f} per 1,000")

# ========================================================================================
# 7. BOT / HUMAN BEHAVIOUR
# ========================================================================================

section("7. BOT / HUMAN BEHAVIOUR")
beh = journeys.groupby("actorType").agg(
    n=("journey_id", "size"),
    median_duration=("journeyDurationSec", "median"),
    median_samples=("sampleCount", "median"),
    median_loot=("Loot", "median"),
    mean_loot=("Loot", "mean"),
    pct_with_loot=("Loot", lambda s: 100 * (s > 0).mean()),
)
print(beh.to_string())

print("\nWho carries Kill/Killed (pure human-vs-human events)?")
print(journeys.groupby("actorType")[["Kill", "Killed"]].sum())

print("\nWho carries BotKill/BotKilled? (both actor types do — see caveat)")
print(journeys.groupby("actorType")[["BotKill", "BotKilled"]].sum())

both_combat = journeys[(journeys.actorType == "bot") & ((journeys.BotKill > 0) | (journeys.BotKilled > 0))]
print(f"\nbot-classified journeys carrying BotKill/BotKilled events: {len(both_combat)} "
      f"of {(journeys.actorType=='bot').sum()} bot journeys "
      f"({100*len(both_combat)/(journeys.actorType=='bot').sum():.1f}%)")
print(f"  BotKill total on bot journeys:   {both_combat.BotKill.sum()}")
print(f"  BotKilled total on bot journeys: {both_combat.BotKilled.sum()}")
human_combat = journeys[(journeys.actorType == "human") & ((journeys.BotKill > 0) | (journeys.BotKilled > 0))]
print(f"  BotKill total on human journeys:   {human_combat.BotKill.sum()}")
print(f"  BotKilled total on human journeys: {human_combat.BotKilled.sum()}")

# ========================================================================================
# 8. MATCH PROGRESSION — event share by quartile of match duration
# ========================================================================================

section("8. MATCH PROGRESSION — event timing as a fraction of match duration")
prog = points.dropna(subset=["matchFrac"]).copy()
prog = prog[(prog.matchFrac >= 0) & (prog.matchFrac <= 1)]
prog["quartile"] = pd.cut(prog.matchFrac, bins=[0, .25, .5, .75, 1.0000001],
                           labels=["Q1 (0-25%)", "Q2 (25-50%)", "Q3 (50-75%)", "Q4 (75-100%)"],
                           include_lowest=True)

for label, codes in [("Storm deaths", STORM), ("Non-storm deaths", DEATHS),
                     ("Kills", KILLS), ("Loot", LOOT), ("Movement (traffic)", MOVEMENT)]:
    sub = prog[prog.event.isin(codes)]
    if len(sub) == 0:
        print(f"\n{label}: n=0, skipped")
        continue
    dist = sub.quartile.value_counts(normalize=True).sort_index() * 100
    n = len(sub)
    print(f"\n{label} (n={n}):")
    for q, pct in dist.items():
        print(f"  {q}: {pct:5.1f}%  (n={int(pct/100*n)})")
    print(f"  baseline if uniform over time: 25.0% per quartile")

# ========================================================================================
# 9. LOW-ACTIVITY CELLS WITHIN THE OBSERVED PLAY ENVELOPE
# ========================================================================================

section("9. LOW-ACTIVITY CELLS WITHIN THE OBSERVED PLAY ENVELOPE")
for map_id, cfg in MAP_CONFIG.items():
    sub = traffic[traffic.map_id == map_id]
    if len(sub) == 0:
        continue
    uvb = cfg["uvBounds"]
    # grid confined to the observed bounding envelope, not the full [0,1] square
    n = 16
    u0, u1, v0, v1 = uvb["minU"], uvb["maxU"], uvb["minV"], uvb["maxV"]
    col = np.clip(((sub.u - u0) / (u1 - u0) * n).astype(int), 0, n - 1)
    row = np.clip((1 - (sub.v - v0) / (v1 - v0)) * n, 0, n - 1).astype(int)
    cell = row * n + col
    counts = cell.value_counts()
    total_cells = n * n
    occupied = counts.size
    empty = total_cells - occupied
    print(f"{map_id}: {n}x{n}={total_cells} cells within observed envelope "
          f"[{u0:.3f},{u1:.3f}]x[{v0:.3f},{v1:.3f}]")
    print(f"  occupied: {occupied}  empty: {empty}  "
          f"({100*empty/total_cells:.1f}% of envelope cells have zero recorded traffic, "
          f"n_traffic={len(sub):,})")

# ========================================================================================
# 10. CANDIDATE ROTATION CORRIDORS — high traffic-to-loot, high traffic-to-kill ratio cells
# ========================================================================================

section("10. CANDIDATE ROTATION CORRIDORS (heuristic: high traffic, low loot/combat density)")
for map_id in MAP_CONFIG:
    t = traffic[traffic.map_id == map_id]
    l = loot[loot.map_id == map_id]
    k = pd.concat([kills[kills.map_id == map_id], deaths[deaths.map_id == map_id]])
    if len(t) == 0:
        continue
    tc = to_grid(t, GRID_N).value_counts()
    lc = to_grid(l, GRID_N).value_counts() if len(l) else pd.Series(dtype=int)
    kc = to_grid(k, GRID_N).value_counts() if len(k) else pd.Series(dtype=int)

    df = pd.DataFrame({"traffic": tc}).fillna(0)
    df["loot"] = lc.reindex(df.index).fillna(0)
    df["combat"] = kc.reindex(df.index).fillna(0)
    # only consider cells with a meaningful traffic sample
    df = df[df.traffic >= 30]
    df["loot_per_traffic"] = df.loot / df.traffic
    df["combat_per_traffic"] = df.combat / df.traffic
    high_traffic_low_activity = df.sort_values(
        ["traffic"], ascending=False
    ).query("loot_per_traffic < @df.loot_per_traffic.median() and "
            "combat_per_traffic < @df.combat_per_traffic.median()")
    print(f"\n{map_id}: {len(df)} cells with traffic>=30 "
          f"(median loot/traffic={df.loot_per_traffic.median():.4f}, "
          f"median combat/traffic={df.combat_per_traffic.median():.4f})")
    print(f"  cells that are high-traffic AND below-median loot AND below-median combat: "
          f"{len(high_traffic_low_activity)}")
    print(high_traffic_low_activity.head(5).to_string())

print("\nDone.")
