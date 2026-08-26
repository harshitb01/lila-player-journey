"""Production preprocessing pipeline: raw Parquet -> frontend-ready static artifacts.

Stages
------
    1. discover        recursively find telemetry files (no .parquet extension required)
    2. load + decode   read Parquet, validate schema, decode `event` bytes safely
    3. deduplicate     remove the duplicated file, then exact duplicate rows
    4. temporal        normalise timestamps, derive source date, anchor match clocks
    5. classify        human/bot per journey from movement vocabulary
    6. reconstruct     assemble matches from journeys
    7. project         apply the validated world->UV transform and verify every point
    8. emit            write manifest, index, per-map tracks, minimap derivatives
    9. verify          reconcile row counts and run structural validation

Design rules
------------
* **Fail loudly on critical corruption.** Schema drift, nulls in required columns, unknown
  maps or events, out-of-bounds projections and reconciliation mismatches abort the build.
* **Report non-critical anomalies.** Duplicates, actor-id conflicts, misfiled day folders
  and degenerate journeys are counted and surfaced, never silently absorbed.
* **Deterministic.** Identical input produces byte-identical output. Ordering is explicit
  everywhere and no wall-clock timestamp is written unless `--stamp` is passed.
* **Rerunnable, unattended.** No prompts, no manual steps, safe to re-run over its own output.

Usage:
    python scripts/build_data.py
    python scripts/build_data.py --out public/data --skip-images
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

# --------------------------------------------------------------------------------------
# Contract constants
# --------------------------------------------------------------------------------------

SCHEMA_VERSION = 1

DATA_COLUMNS = ["user_id", "match_id", "map_id", "x", "y", "z", "ts", "event"]

#: Expected Arrow types. Schema drift against this is critical.
EXPECTED_ARROW_TYPES = {
    "user_id": "string", "match_id": "string", "map_id": "string",
    "x": "float", "y": "float", "z": "float",
    "ts": "timestamp[ms]", "event": "binary",
}

#: Pinned event dictionary. Codes are part of the wire contract and must never be
#: renumbered; new events append.
EVENT_CODES = {
    "BotKill": 0, "BotKilled": 1, "BotPosition": 2, "Kill": 3,
    "Killed": 4, "KilledByStorm": 5, "Loot": 6, "Position": 7,
}

MOVEMENT_HUMAN = "Position"
MOVEMENT_BOT = "BotPosition"

#: Authoritative map/projection contract, shared with the TypeScript renderer.
MAP_CONFIG_PATH = Path(__file__).resolve().parents[1] / "map-config.json"
MAP_CONFIGS = json.loads(MAP_CONFIG_PATH.read_text(encoding="utf-8"))
MINIMAP_SOURCES = {
    map_id: config["minimapSource"] for map_id, config in MAP_CONFIGS.items()
}

MATCH_SUFFIX = ".nakama-0"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

#: Files that ship alongside telemetry but are not telemetry.
IGNORED_NAMES = {".ds_store", "readme.md", ".gitkeep", "thumbs.db"}
IGNORED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".md", ".json", ".txt", ".zip"}
IGNORED_DIRS = {"minimaps"}

#: Coordinates ship as integer centi-units. See DATA_MODEL.md §12 for the error budget.
COORD_SCALE = 100

#: tRel is emitted as Uint16 on the client.
MAX_T_REL = 65535


class CriticalError(RuntimeError):
    """Raised when the input is corrupt in a way that would produce a wrong picture."""


# --------------------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------------------


@dataclass
class Anomaly:
    category: str
    severity: str          # "warning" | "critical"
    count: int
    detail: str


@dataclass
class Report:
    anomalies: list[Anomaly] = field(default_factory=list)
    counters: dict = field(default_factory=dict)

    def warn(self, category: str, count: int, detail: str) -> None:
        self.anomalies.append(Anomaly(category, "warning", count, detail))
        print(f"   [warn] {category}: {count} — {detail}")

    def critical(self, category: str, count: int, detail: str) -> None:
        self.anomalies.append(Anomaly(category, "critical", count, detail))
        raise CriticalError(f"{category}: {count} — {detail}")

    def count(self, key: str, value) -> None:
        self.counters[key] = value


def stage(n: int, title: str) -> None:
    print(f"\n[{n}/9] {title}")


# --------------------------------------------------------------------------------------
# Stage 1 — discover
# --------------------------------------------------------------------------------------


def discover(data_dir: Path) -> list[Path]:
    """Recursively find telemetry files. Extension-agnostic by design."""
    found = []
    for p in sorted(data_dir.rglob("*")):
        if p.is_dir() or p.name.lower() in IGNORED_NAMES:
            continue
        if p.suffix.lower() in IGNORED_SUFFIXES:
            continue
        if any(part.lower() in IGNORED_DIRS for part in p.relative_to(data_dir).parts[:-1]):
            continue
        found.append(p)
    return sorted(found)                       # explicit order => deterministic build


# --------------------------------------------------------------------------------------
# Stage 2 — load, validate schema, decode
# --------------------------------------------------------------------------------------


def decode_event(value) -> str:
    """Decode the `event` column, which is stored as unannotated bytes.

    Uses strict UTF-8: a decode failure means the payload is not what the schema
    promises, which is corruption worth failing on rather than mojibake worth shipping.
    """
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="strict")
    if isinstance(value, str):
        return value
    raise CriticalError(f"event column holds unexpected type {type(value).__name__}")


def load_and_validate(paths: list[Path], data_dir: Path, rep: Report,
                      allow_unreadable: bool) -> pd.DataFrame:
    frames, unreadable, schema_variants = [], [], Counter()

    for path in paths:
        try:
            pf = pq.ParquetFile(path)
            arrow = pf.schema_arrow
            signature = tuple(f"{f.name}:{f.type}" for f in arrow)
            schema_variants[signature] += 1

            names = [f.name for f in arrow]
            if names != DATA_COLUMNS:
                rep.critical("schema_columns", 1,
                             f"{path.name} has columns {names}, expected {DATA_COLUMNS}")
            for f in arrow:
                if str(f.type) != EXPECTED_ARROW_TYPES[f.name]:
                    rep.critical("schema_types", 1,
                                 f"{path.name}: column {f.name} is {f.type}, "
                                 f"expected {EXPECTED_ARROW_TYPES[f.name]}")

            table = pf.read()
            for i in range(table.num_columns):
                if table.column(i).null_count:
                    rep.critical("null_in_required_column", table.column(i).null_count,
                                 f"{path.name}: column {table.schema.field(i).name}")

            df = table.to_pandas()
            df["_file"] = path.name
            df["_day_folder"] = path.parent.name
            frames.append(df)
        except CriticalError:
            raise
        except Exception as exc:
            unreadable.append((path, f"{type(exc).__name__}: {exc}"))

    if unreadable:
        detail = "; ".join(f"{p.relative_to(data_dir)} ({e})" for p, e in unreadable[:5])
        if allow_unreadable:
            rep.warn("unreadable_files", len(unreadable), detail)
        else:
            rep.critical("unreadable_files", len(unreadable),
                         f"{detail} — rerun with --allow-unreadable to downgrade")

    if not frames:
        raise CriticalError(f"no readable telemetry found under {data_dir}")

    print(f"   files read      : {len(frames)}")
    print(f"   schema variants : {len(schema_variants)} (1 expected)")

    df = pd.concat(frames, ignore_index=True)
    df["event"] = df["event"].map(decode_event)

    unknown = sorted(set(df.event.unique()) - set(EVENT_CODES))
    if unknown:
        rep.critical("unknown_event_type", len(unknown), f"{unknown}")
    unknown_maps = sorted(set(df.map_id.unique()) - set(MAP_CONFIGS))
    if unknown_maps:
        rep.critical("unknown_map_id", len(unknown_maps), f"{unknown_maps}")

    print(f"   rows decoded    : {len(df):,}")
    return df


# --------------------------------------------------------------------------------------
# Stage 3 — deduplicate
# --------------------------------------------------------------------------------------


def deduplicate(df: pd.DataFrame, rep: Report) -> pd.DataFrame:
    """File-level first (a whole journey shipped twice), then exact duplicate rows."""
    before = len(df)

    per_file_folders = df.groupby("_file")._day_folder.nunique()
    dup_files = sorted(per_file_folders[per_file_folders > 1].index)
    dropped_file_rows = 0
    if dup_files:
        keep = df[df._file.isin(dup_files)].groupby("_file")._day_folder.min()
        redundant = df._file.isin(dup_files) & (df._day_folder != df._file.map(keep))
        dropped_file_rows = int(redundant.sum())
        for name in dup_files:
            copies = [g[DATA_COLUMNS].reset_index(drop=True)
                      for _, g in df[df._file == name].groupby("_day_folder")]
            identical = all(copies[0].equals(c) for c in copies[1:])
            if not identical:
                rep.critical("conflicting_duplicate_file", 1,
                             f"{name} appears in multiple folders with DIFFERENT content")
        rep.warn("duplicate_file", len(dup_files),
                 f"{dup_files[0]} shipped in 2 day folders, byte-identical; "
                 f"dropped {dropped_file_rows} rows")
        df = df[~redundant]

    dup_rows = df.duplicated(subset=DATA_COLUMNS, keep="first")
    dropped_row_count = int(dup_rows.sum())
    if dropped_row_count:
        by_event = df[dup_rows].event.value_counts().to_dict()
        rep.warn("duplicate_rows", dropped_row_count,
                 f"exact duplicates across all 8 columns, by event: {by_event}")
    df = df[~dup_rows].copy()

    rep.count("dropped_duplicate_file_rows", dropped_file_rows)
    rep.count("dropped_duplicate_rows", dropped_row_count)
    print(f"   {before:,} -> {len(df):,} rows "
          f"(-{dropped_file_rows} duplicate file, -{dropped_row_count} duplicate rows)")
    return df


# --------------------------------------------------------------------------------------
# Stage 4 — temporal normalisation
# --------------------------------------------------------------------------------------


def normalise_time(df: pd.DataFrame, rep: Report) -> pd.DataFrame:
    """Read the INT64 payload directly and anchor each match's clock.

    The Parquet logical type declares milliseconds, but the stored integers are epoch
    SECONDS (see DATA_ANALYSIS.md §9). Decoding via the declared unit would place this
    data in 1970. The payload is therefore read as an integer and never passed through a
    timestamp decoder.
    """
    df = df.copy()
    df["ts_raw"] = df["ts"].astype("int64")

    utc = pd.to_datetime(df["ts_raw"], unit="s", utc=True)
    df["date"] = utc.dt.strftime("%Y-%m-%d")

    # Day folders are unreliable: they misfile late-night matches. Report, keep both.
    expected = df._day_folder.str.replace("February_", "2026-02-", regex=False)
    mismatched = df[df.date != expected]
    if len(mismatched):
        pairs = (mismatched.groupby(["_day_folder", "date"]).size()
                 .sort_values(ascending=False).head(5).to_dict())
        rep.warn("day_folder_date_mismatch", len(mismatched),
                 f"{mismatched.match_id.nunique()} matches straddle or precede their "
                 f"folder's UTC day; folder->derived counts {pairs}. "
                 f"Derived date is authoritative; folder kept as provenance.")

    df["match_t0"] = df.groupby("match_id").ts_raw.transform("min")
    df["t_rel"] = df["ts_raw"] - df["match_t0"]

    if (df.t_rel < 0).any():
        rep.critical("negative_match_relative_time", int((df.t_rel < 0).sum()),
                     "t_rel must be >= 0 by construction")
    if (df.t_rel > MAX_T_REL).any():
        rep.critical("t_rel_overflow", int((df.t_rel > MAX_T_REL).sum()),
                     f"t_rel exceeds Uint16 range ({MAX_T_REL})")

    print(f"   UTC span    : {utc.min()} -> {utc.max()}")
    print(f"   dates       : {sorted(df.date.unique())}")
    print(f"   t_rel range : 0 .. {int(df.t_rel.max())} s")
    return df


# --------------------------------------------------------------------------------------
# Stage 5 — actor classification
# --------------------------------------------------------------------------------------


def classify_actors(df: pd.DataFrame, rep: Report) -> pd.DataFrame:
    """Classify per journey by movement vocabulary; keep the id-based rule alongside."""
    df = df.copy()
    df["journey_key"] = df.user_id + "|" + df.match_id
    df["id_format"] = np.where(df.user_id.str.match(UUID_RE), "uuid", "numeric")

    flags = df.groupby("journey_key").event.agg(
        has_human=lambda s: (s == MOVEMENT_HUMAN).any(),
        has_bot=lambda s: (s == MOVEMENT_BOT).any(),
    )
    both = flags[flags.has_human & flags.has_bot]
    neither = flags[~flags.has_human & ~flags.has_bot]
    if len(both):
        rep.critical("journey_mixed_movement_vocabulary", len(both),
                     f"e.g. {both.index[0]} — classification rule is no longer total")
    if len(neither):
        rep.critical("journey_without_movement_events", len(neither),
                     f"e.g. {neither.index[0]} — cannot classify or draw a path")

    actor = np.where(flags.has_bot, "bot", "human")
    df["actor_type"] = df.journey_key.map(pd.Series(actor, index=flags.index))
    df["actor_by_id"] = np.where(df.id_format == "numeric", "bot", "human")
    df["actor_id_conflict"] = df.actor_type != df.actor_by_id

    conflicts = df[df.actor_id_conflict].journey_key.nunique()
    if conflicts:
        ids = sorted(df[df.actor_id_conflict].user_id.unique())
        rep.warn("actor_id_conflict", conflicts,
                 f"numeric user_id emitting human vocabulary; user_ids {ids}. "
                 f"Movement vocabulary wins; id_format retained for reconstruction.")

    # The bot cohort must stay behaviourally pure or the rule has degraded.
    human_only = {"Position", "Loot", "Kill", "Killed", "KilledByStorm"}
    leak = set(df[df.actor_type == "bot"].event.unique()) & human_only
    if leak:
        rep.critical("bot_cohort_contaminated", len(leak),
                     f"bot-vocabulary journeys emit human-only events {sorted(leak)}")

    counts = df.groupby("journey_key").actor_type.first().value_counts().to_dict()
    print(f"   journeys by actor type: {counts}")
    rep.count("actor_id_conflicts", int(conflicts))
    return df


# --------------------------------------------------------------------------------------
# Stage 6 — match reconstruction
# --------------------------------------------------------------------------------------


def reconstruct_matches(df: pd.DataFrame, rep: Report) -> pd.DataFrame:
    per_match = df.groupby("match_id").agg(journeys=("journey_key", "nunique"),
                                           maps=("map_id", "nunique"))
    if (per_match.maps > 1).any():
        bad = per_match[per_match.maps > 1]
        rep.critical("match_spans_multiple_maps", len(bad), f"e.g. {bad.index[0]}")

    single = int((per_match.journeys == 1).sum())
    rep.warn("partial_roster_matches", single,
             f"{100 * single / len(per_match):.1f}% of matches contain exactly one "
             f"journey; a full roster cannot be reconstructed for them")

    deaths = df[df.event.isin(["Killed", "BotKilled", "KilledByStorm"])]
    multi_death = deaths.groupby("journey_key").size()
    multi = multi_death[multi_death > 1]
    if len(multi):
        rep.warn("journey_with_multiple_deaths", len(multi),
                 "a journey records more than one death event, which is internally "
                 "inconsistent for a single life; both events are retained")

    movement = df[df.event.isin([MOVEMENT_HUMAN, MOVEMENT_BOT])]
    samples = movement.groupby("journey_key").size()
    degenerate = samples[samples < 2]
    if len(degenerate):
        rep.warn("journey_with_single_sample", len(degenerate),
                 "fewer than 2 movement samples; no path can be drawn, point only")

    print(f"   matches      : {len(per_match):,}")
    print(f"   journeys     : {df.journey_key.nunique():,}")
    print(f"   single-journey matches: {single:,}")
    return df


# --------------------------------------------------------------------------------------
# Stage 7 — projection
# --------------------------------------------------------------------------------------


def project(df: pd.DataFrame, rep: Report) -> pd.DataFrame:
    """Apply the validated transform and verify every resulting point is on the map."""
    df = df.copy()
    u = np.empty(len(df), dtype=np.float64)
    v = np.empty(len(df), dtype=np.float64)

    for map_id, idx in df.groupby("map_id").groups.items():
        cfg = MAP_CONFIGS[map_id]
        pos = df.index.get_indexer(idx)
        u[pos] = (df.loc[idx, "x"].to_numpy() - cfg["originX"]) / cfg["scale"]
        v[pos] = (df.loc[idx, "z"].to_numpy() - cfg["originZ"]) / cfg["scale"]

    df["u"], df["v"] = u, v
    outside = (u < 0) | (u > 1) | (v < 0) | (v > 1)
    if outside.any():
        sample = df[outside].head(3)[["map_id", "x", "z"]].to_dict("records")
        rep.critical("projection_out_of_bounds", int(outside.sum()),
                     f"points fall outside the minimap, e.g. {sample}")

    print(f"   projected {len(df):,} points, {int(outside.sum())} out of bounds")
    return df


# --------------------------------------------------------------------------------------
# Stage 8 — emit
# --------------------------------------------------------------------------------------


def write_json(path: Path, payload, minified: bool = True) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, separators=(",", ":") if minified else None,
                      indent=None if minified else 2, sort_keys=False,
                      ensure_ascii=False, allow_nan=False)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def build_minimaps(minimap_dir: Path, out_dir: Path, width: int,
                   thumb: int, rep: Report) -> dict:
    """Downscale the source artwork to web-deliverable WebP."""
    try:
        from PIL import Image
    except ImportError:
        rep.warn("minimaps_skipped", 3, "Pillow not installed; run with --skip-images "
                                        "or `pip install Pillow`")
        return {}

    Image.MAX_IMAGE_PIXELS = None
    out_dir.mkdir(parents=True, exist_ok=True)
    result = {}
    for map_id, filename in MINIMAP_SOURCES.items():
        src = minimap_dir / filename
        if not src.exists():
            rep.critical("minimap_missing", 1, f"{src} not found")
        img = Image.open(src).convert("RGB")
        natural = img.size

        full = img.copy()
        full.thumbnail((width, width), Image.LANCZOS)
        full_path = out_dir / f"{map_id}.webp"
        full.save(full_path, "WEBP", quality=82, method=6)

        small = img.copy()
        small.thumbnail((thumb, thumb), Image.LANCZOS)
        thumb_path = out_dir / f"{map_id}_thumb.webp"
        small.save(thumb_path, "WEBP", quality=80, method=6)

        result[map_id] = {
            "width": full.size[0], "height": full.size[1],
            "naturalWidth": natural[0], "naturalHeight": natural[1],
            "bytes": full_path.stat().st_size, "thumbBytes": thumb_path.stat().st_size,
        }
        if natural[0] != natural[1]:
            rep.warn("minimap_not_square", 1,
                     f"{map_id} source is {natural[0]}x{natural[1]}; aspect preserved "
                     f"in the delivered image and carried in maps.json")
    return result


def emit(df: pd.DataFrame, out_dir: Path, images: dict, rep: Report) -> dict:
    """Write the frontend contract. Ids are integers; strings are never repeated."""
    sizes: dict[str, int] = {}

    # Deterministic ordering: matches by (map, match_id); journeys by (match, user).
    match_order = (df.groupby("match_id").agg(map_id=("map_id", "first"))
                   .sort_values(["map_id", "match_id"], kind="stable"))
    match_index = {mid: i for i, mid in enumerate(match_order.index)}

    journey_meta = (df.groupby("journey_key")
                    .agg(user_id=("user_id", "first"), match_id=("match_id", "first"),
                         map_id=("map_id", "first"), date=("date", "first"),
                         source_folder=("_day_folder", "first"),
                         actor_type=("actor_type", "first"),
                         id_format=("id_format", "first"),
                         actor_id_conflict=("actor_id_conflict", "first"),
                         start_t_rel=("t_rel", "min"), end_t_rel=("t_rel", "max"),
                         rows=("event", "size")))
    journey_meta["mi"] = journey_meta.match_id.map(match_index)
    journey_meta = journey_meta.sort_values(["mi", "user_id"], kind="stable")
    journey_index = {k: i for i, k in enumerate(journey_meta.index)}

    event_counts = (df.groupby(["journey_key", "event"]).size()
                    .unstack(fill_value=0).reindex(journey_meta.index))
    movement_cols = [c for c in (MOVEMENT_HUMAN, MOVEMENT_BOT) if c in event_counts]

    # The index is columnar and dictionary-encoded. A row-oriented form repeats every
    # field NAME 1,242 times (~150 KB of pure key duplication) and every low-cardinality
    # value in full. Column arrays are positionally aligned; element i of each is
    # journey i.
    event_order = [e for e, _ in sorted(EVENT_CODES.items(), key=lambda kv: kv[1])]
    date_dict = sorted(journey_meta.date.unique())
    folder_dict = sorted(journey_meta.source_folder.unique())
    map_dict = sorted(MAP_CONFIGS)
    actor_dict = ["human", "bot"]
    id_format_dict = ["uuid", "numeric"]

    keys = list(journey_meta.index)
    counts_matrix = [
        [int(event_counts.loc[k][e]) if e in event_counts else 0 for e in event_order]
        for k in keys
    ]
    journeys_col = {
        "count": len(keys),
        "userId": [journey_meta.loc[k, "user_id"] for k in keys],
        "match": [int(journey_meta.loc[k, "mi"]) for k in keys],
        "date": [date_dict.index(journey_meta.loc[k, "date"]) for k in keys],
        "sourceFolder": [folder_dict.index(journey_meta.loc[k, "source_folder"])
                         for k in keys],
        "actorType": [actor_dict.index(journey_meta.loc[k, "actor_type"]) for k in keys],
        "idFormat": [id_format_dict.index(journey_meta.loc[k, "id_format"]) for k in keys],
        "actorIdConflict": [int(bool(journey_meta.loc[k, "actor_id_conflict"]))
                            for k in keys],
        "startTRel": [int(journey_meta.loc[k, "start_t_rel"]) for k in keys],
        "durationSec": [int(journey_meta.loc[k, "end_t_rel"]
                            - journey_meta.loc[k, "start_t_rel"]) for k in keys],
        "sampleCount": [int(event_counts.loc[k][movement_cols].sum()) for k in keys],
        "eventCounts": counts_matrix,
    }

    match_rollup = df.groupby("match_id").agg(started_at=("match_t0", "first"),
                                              duration=("t_rel", "max"))
    ordered_matches = [mid for mid, _ in sorted(match_index.items(), key=lambda kv: kv[1])]
    matches_col = {
        "count": len(ordered_matches),
        # The .nakama-0 suffix is on every match id; strip it once, restore on read.
        "matchId": [m.removesuffix(MATCH_SUFFIX) for m in ordered_matches],
        "mapId": [map_dict.index(match_order.loc[m, "map_id"]) for m in ordered_matches],
        "startedAt": [int(match_rollup.loc[m, "started_at"]) for m in ordered_matches],
        "durationSec": [int(match_rollup.loc[m, "duration"]) for m in ordered_matches],
    }
    # match -> journeys is deliberately NOT stored: it is the exact inverse of
    # journeys.match and is rebuilt client-side in one pass.

    sizes["index.json"] = write_json(out_dir / "index.json", {
        "schemaVersion": SCHEMA_VERSION,
        "dictionaries": {
            "date": date_dict, "sourceFolder": folder_dict, "mapId": map_dict,
            "actorType": actor_dict, "idFormat": id_format_dict, "event": event_order,
            "matchSuffix": MATCH_SUFFIX,
        },
        "matches": matches_col,
        "journeys": journeys_col,
    })

    # Row-oriented views for the verification stage only; never written to disk.
    journeys = [{"id": i, "match": journeys_col["match"][i],
                 "eventCounts": counts_matrix[i]} for i in range(len(keys))]
    matches = [{"id": i} for i in range(len(ordered_matches))]

    # ---- per-map track files -----------------------------------------------------
    maps_meta = []
    for map_id in sorted(MAP_CONFIGS):
        g = df[df.map_id == map_id]
        cfg = MAP_CONFIGS[map_id]
        tracks = []
        for key in [k for k in journey_meta.index if journey_meta.loc[k, "map_id"] == map_id]:
            j = g[g.journey_key == key].sort_values(["t_rel", "event"], kind="stable")
            tracks.append({
                "j": journey_index[key],
                "t": j.t_rel.astype(int).tolist(),
                "x": np.round(j.x.to_numpy() * COORD_SCALE).astype(int).tolist(),
                "z": np.round(j.z.to_numpy() * COORD_SCALE).astype(int).tolist(),
                "e": [EVENT_CODES[e] for e in j.event],
            })
        name = f"tracks/{map_id}.json"
        sizes[name] = write_json(out_dir / name, {"map": map_id, "tracks": tracks})

        img = images.get(map_id, {})
        # A map with no telemetry has no bounds. Emit nulls and warn rather than
        # letting NaN reach the JSON encoder, which fails with an opaque error.
        if len(g):
            world_bounds = {"minX": float(g.x.min()), "maxX": float(g.x.max()),
                            "minZ": float(g.z.min()), "maxZ": float(g.z.max())}
            uv_bounds = {"minU": float(g.u.min()), "maxU": float(g.u.max()),
                         "minV": float(g.v.min()), "maxV": float(g.v.max())}
        else:
            world_bounds = uv_bounds = None
            rep.warn("map_without_telemetry", 1,
                     f"{map_id} has no rows in this build; bounds emitted as null and "
                     f"the map should be disabled in the UI")

        maps_meta.append({
            "id": map_id,
            "displayName": cfg["displayName"],
            "projection": {"scale": cfg["scale"], "originX": cfg["originX"],
                           "originZ": cfg["originZ"]},
            "image": {
                "url": f"minimaps/{map_id}.webp",
                "thumbnailUrl": f"minimaps/{map_id}_thumb.webp",
                "width": img.get("width"), "height": img.get("height"),
                "naturalWidth": img.get("naturalWidth"),
                "naturalHeight": img.get("naturalHeight"),
            },
            "worldBounds": world_bounds,
            "uvBounds": uv_bounds,
            "totals": {"journeys": int(g.journey_key.nunique()),
                       "matches": int(g.match_id.nunique()), "rows": int(len(g))},
        })

    sizes["maps.json"] = write_json(out_dir / "maps.json", {"maps": maps_meta})
    return {"sizes": sizes, "journeys": journeys, "matches": matches,
            "journey_index": journey_index, "maps": maps_meta}


# --------------------------------------------------------------------------------------
# Stage 9 — verification
# --------------------------------------------------------------------------------------


def verify(out_dir: Path, df: pd.DataFrame, built: dict, source_rows: int,
           rep: Report) -> list[tuple[str, bool, str]]:
    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, bool(ok), detail))

    index = json.loads((out_dir / "index.json").read_text(encoding="utf-8"))
    maps = json.loads((out_dir / "maps.json").read_text(encoding="utf-8"))

    dropped = rep.counters["dropped_duplicate_file_rows"] + rep.counters["dropped_duplicate_rows"]
    check("row reconciliation: source - dropped == processed",
          source_rows - dropped == len(df),
          f"{source_rows:,} - {dropped:,} = {source_rows - dropped:,} vs {len(df):,}")

    track_rows = 0
    for m in maps["maps"]:
        data = json.loads((out_dir / f"tracks/{m['id']}.json").read_text(encoding="utf-8"))
        for t in data["tracks"]:
            n = len(t["t"])
            if not (len(t["x"]) == len(t["z"]) == len(t["e"]) == n):
                check(f"track arrays aligned ({m['id']})", False, f"journey {t['j']}")
                break
            track_rows += n
        else:
            check(f"track arrays aligned ({m['id']})", True, f"{len(data['tracks'])} journeys")
    check("track rows == processed rows", track_rows == len(df),
          f"{track_rows:,} vs {len(df):,}")

    jc, mc = index["journeys"], index["matches"]
    check("journey count matches", jc["count"] == df.journey_key.nunique(), f"{jc['count']:,}")
    check("match count matches", mc["count"] == df.match_id.nunique(), f"{mc['count']:,}")

    column_lengths = {k: len(v) for k, v in jc.items() if isinstance(v, list)}
    check("journey columns are equal length",
          set(column_lengths.values()) == {jc["count"]}, f"{sorted(set(column_lengths.values()))}")
    check("match columns are equal length",
          {len(v) for v in mc.values() if isinstance(v, list)} == {mc["count"]})

    check("every journey references a valid match",
          all(0 <= m < mc["count"] for m in jc["match"]))
    check("every match is referenced by >=1 journey",
          set(jc["match"]) == set(range(mc["count"])),
          f"{len(set(jc['match'])):,} of {mc['count']:,}")

    dicts = index["dictionaries"]
    check("dictionary codes in range",
          all(0 <= c < len(dicts["date"]) for c in jc["date"])
          and all(0 <= c < len(dicts["actorType"]) for c in jc["actorType"])
          and all(0 <= c < len(dicts["mapId"]) for c in mc["mapId"]))

    per_journey_rows = {i: sum(jc["eventCounts"][i]) for i in range(jc["count"])}
    mismatched = 0
    for m in maps["maps"]:
        data = json.loads((out_dir / f"tracks/{m['id']}.json").read_text(encoding="utf-8"))
        for t in data["tracks"]:
            if per_journey_rows[t["j"]] != len(t["t"]):
                mismatched += 1
    check("index eventCounts == track lengths", mismatched == 0, f"{mismatched} mismatched")

    all_codes = set(EVENT_CODES.values())
    bad_codes = 0
    max_t = 0
    for m in maps["maps"]:
        data = json.loads((out_dir / f"tracks/{m['id']}.json").read_text(encoding="utf-8"))
        for t in data["tracks"]:
            bad_codes += sum(1 for c in t["e"] if c not in all_codes)
            if t["t"]:
                max_t = max(max_t, max(t["t"]))
                if any(v < 0 for v in t["t"]):
                    bad_codes += 1
    check("all event codes known", bad_codes == 0)
    check("all t_rel within Uint16", 0 <= max_t <= MAX_T_REL, f"max {max_t}")

    # Re-project from the emitted integer coordinates: the decode path the client uses.
    off = 0
    worst = 0.0
    for m in maps["maps"]:
        cfg = m["projection"]
        data = json.loads((out_dir / f"tracks/{m['id']}.json").read_text(encoding="utf-8"))
        for t in data["tracks"]:
            xs = np.array(t["x"], dtype=np.float64) / COORD_SCALE
            zs = np.array(t["z"], dtype=np.float64) / COORD_SCALE
            u = (xs - cfg["originX"]) / cfg["scale"]
            v = (zs - cfg["originZ"]) / cfg["scale"]
            off += int(((u < 0) | (u > 1) | (v < 0) | (v > 1)).sum())
    check("emitted coordinates all project on-map", off == 0, f"{off} off-map")

    # Round-trip the emitted integers back to world units and compare against the
    # source floats, per journey, in the order the tracks were written.
    #
    # The budget is the rounding step PLUS the granularity of the source itself: `x` is
    # float32, whose ULP near the largest observed coordinate (~407) is about 3.05e-5.
    # A budget of exactly 0.5/scale ignores that and is unachievable by ~1.7e-5.
    largest = float(max(df.x.abs().max(), df.z.abs().max()))
    float32_ulp = float(np.spacing(np.float32(largest)))
    budget = 0.5 / COORD_SCALE + float32_ulp
    ordered = df.sort_values(["journey_key", "t_rel", "event"], kind="stable")
    by_journey = {k: g for k, g in ordered.groupby("journey_key", sort=False)}
    key_by_id = {jid: key for key, jid in built["journey_index"].items()}
    for m in maps["maps"]:
        data = json.loads((out_dir / f"tracks/{m['id']}.json").read_text(encoding="utf-8"))
        for t in data["tracks"]:
            src = by_journey[key_by_id[t["j"]]]
            xs = np.array(t["x"], dtype=np.float64) / COORD_SCALE
            zs = np.array(t["z"], dtype=np.float64) / COORD_SCALE
            worst = max(worst,
                        float(np.abs(xs - src.x.to_numpy()).max()),
                        float(np.abs(zs - src.z.to_numpy()).max()))
    check("coordinate round-trip within quantisation budget", worst <= budget,
          f"max error {worst:.6f} <= {budget:.6f} "
          f"(rounding {0.5 / COORD_SCALE} + float32 ulp {float32_ulp:.2e})")

    check("no NaN or Inf in emitted maps metadata",
          all(np.isfinite([v for b in (m["worldBounds"], m["uvBounds"])
                           for v in b.values()]).all()
              for m in maps["maps"]
              if m["worldBounds"] is not None and m["uvBounds"] is not None))
    return checks


def hash_outputs(out_dir: Path) -> tuple[str, list[tuple[str, int]]]:
    """Content hash over every emitted artifact, for determinism verification."""
    digest = hashlib.sha256()
    files = []
    for p in sorted(out_dir.rglob("*")):
        if p.is_file() and p.name != "manifest.json":
            rel = p.relative_to(out_dir).as_posix()
            data = p.read_bytes()
            digest.update(rel.encode())
            digest.update(data)
            files.append((rel, len(data)))
    return digest.hexdigest(), files


# --------------------------------------------------------------------------------------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    ap.add_argument("--minimap-dir", type=Path, default=Path("data/raw/minimaps"))
    ap.add_argument("--out", type=Path, default=Path("public/data"))
    ap.add_argument("--image-width", type=int, default=2048)
    ap.add_argument("--thumb-width", type=int, default=256)
    ap.add_argument("--skip-images", action="store_true")
    ap.add_argument("--allow-unreadable", action="store_true",
                    help="downgrade unreadable files from critical to a warning")
    ap.add_argument("--stamp", action="store_true",
                    help="embed a build timestamp (breaks byte-determinism)")
    args = ap.parse_args(argv)

    rep = Report()
    print(f"LILA BLACK data pipeline  |  {args.data_dir.resolve()} -> {args.out.resolve()}")

    try:
        stage(1, "discover")
        if not args.data_dir.exists():
            raise CriticalError(f"data directory not found: {args.data_dir}")
        paths = discover(args.data_dir)
        print(f"   telemetry files discovered: {len(paths)}")
        if not paths:
            raise CriticalError(f"no telemetry files under {args.data_dir}")

        stage(2, "load, validate schema, decode event bytes")
        df = load_and_validate(paths, args.data_dir, rep, args.allow_unreadable)
        source_rows = len(df)
        rep.count("source_files", len(paths))
        rep.count("source_rows", source_rows)

        stage(3, "deduplicate")
        df = deduplicate(df, rep)

        stage(4, "normalise timestamps and derive source date")
        df = normalise_time(df, rep)

        stage(5, "classify humans and bots")
        df = classify_actors(df, rep)

        stage(6, "reconstruct matches")
        df = reconstruct_matches(df, rep)

        stage(7, "project world coordinates to minimap space")
        df = project(df, rep)
        rep.count("processed_rows", len(df))

        stage(8, "emit frontend artifacts")
        if args.out.exists():
            shutil.rmtree(args.out)          # rerunnable: never merge with a stale build
        args.out.mkdir(parents=True)
        images = ({} if args.skip_images
                  else build_minimaps(args.minimap_dir, args.out / "minimaps",
                                      args.image_width, args.thumb_width, rep))
        built = emit(df, args.out, images, rep)

        stage(9, "verify")
        checks = verify(args.out, df, built, source_rows, rep)

    except CriticalError as exc:
        print(f"\nBUILD FAILED (critical): {exc}", file=sys.stderr)
        return 1

    content_hash, files = hash_outputs(args.out)
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "contentHash": content_hash,
        "eventCodes": EVENT_CODES,
        "coordinateScale": COORD_SCALE,
        "source": {"files": rep.counters["source_files"],
                   "rows": rep.counters["source_rows"]},
        "processed": {"rows": rep.counters["processed_rows"],
                      "journeys": int(df.journey_key.nunique()),
                      "matches": int(df.match_id.nunique()),
                      "players": int(df.user_id.nunique()),
                      "dates": sorted(df.date.unique())},
        "dropped": {"duplicateFileRows": rep.counters["dropped_duplicate_file_rows"],
                    "duplicateRows": rep.counters["dropped_duplicate_rows"]},
        "dataQuality": [{"category": a.category, "severity": a.severity,
                         "count": a.count, "detail": a.detail} for a in rep.anomalies],
    }
    if args.stamp:
        manifest["generatedAt"] = datetime.now(timezone.utc).isoformat()
    write_json(args.out / "manifest.json", manifest, minified=False)

    # ---- final report ------------------------------------------------------------
    print("\n" + "=" * 86)
    print("ROW RECONCILIATION")
    print("=" * 86)
    dropped_file = rep.counters["dropped_duplicate_file_rows"]
    dropped_rows = rep.counters["dropped_duplicate_rows"]
    total_dropped = dropped_file + dropped_rows
    print(f"   source rows read from Parquet      {source_rows:>10,}")
    print(f"   - duplicate file (byte-identical)  {-dropped_file:>10,}")
    print(f"   - exact duplicate rows             {-dropped_rows:>10,}")
    print(f"   {'=' * 46}")
    print(f"   processed rows written             {len(df):>10,}")
    print(f"   total dropped                      {total_dropped:>10,} "
          f"({100 * total_dropped / source_rows:.2f}%)")

    print("\n" + "=" * 86)
    print("ANOMALY REPORT")
    print("=" * 86)
    for a in rep.anomalies:
        print(f"   [{a.severity}] {a.category} ({a.count})")
        print(f"      {a.detail}")
    if not rep.anomalies:
        print("   none")

    print("\n" + "=" * 86)
    print("OUTPUT SIZES")
    print("=" * 86)
    import gzip as _gz
    total_raw = total_gz = 0
    for rel, size in files + [("manifest.json", (args.out / "manifest.json").stat().st_size)]:
        raw = (args.out / rel).read_bytes()
        gz = len(_gz.compress(raw, 9))
        total_raw += size
        total_gz += gz
        print(f"   {rel:<34} {size / 1024:>9.1f} KB   gzip {gz / 1024:>8.1f} KB")
    print(f"   {'TOTAL':<34} {total_raw / 1024:>9.1f} KB   gzip {total_gz / 1024:>8.1f} KB")

    print("\n" + "=" * 86)
    print("VALIDATION CHECKS")
    print("=" * 86)
    failed = 0
    for name, ok, detail in checks:
        failed += not ok
        print(f"   [{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail else ""))
    print(f"\n   {len(checks) - failed}/{len(checks)} passed")
    print(f"\ncontent hash: {content_hash}")

    if failed:
        print("\nBUILD FAILED: validation checks did not pass", file=sys.stderr)
        return 1
    print("\nBUILD OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
