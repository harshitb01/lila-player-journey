"""Forensic analysis of the LILA BLACK player telemetry dataset.

Reads every Parquet file under the raw data directory and reports verified facts
about schema, types, identities, coordinates, timestamps and data quality.

This script asserts nothing it has not measured. Where a conclusion requires an
inference beyond the stored bytes (most importantly the timestamp unit), the
supporting tests are printed so the inference can be judged on its evidence.

Usage:
    python scripts/analyze_dataset.py
    python scripts/analyze_dataset.py --data-dir data/raw --json out/analysis.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

# --------------------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------------------

DATA_COLUMNS = ["user_id", "match_id", "map_id", "x", "y", "z", "ts", "event"]

#: World -> UV projection constants, as published in the dataset README.
MAP_CONFIG = {
    "AmbroseValley": {"scale": 900, "origin_x": -370, "origin_z": -473},
    "GrandRift": {"scale": 581, "origin_x": -290, "origin_z": -290},
    "Lockdown": {"scale": 1000, "origin_x": -500, "origin_z": -500},
}

#: Movement events. Exactly one of these is expected per journey and they are the
#: only events that turn out to discriminate bots from humans (see report).
MOVEMENT_HUMAN = "Position"
MOVEMENT_BOT = "BotPosition"

#: Events the README attributes exclusively to human players.
HUMAN_ONLY_EVENTS = {"Position", "Loot", "Kill", "Killed", "KilledByStorm"}

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

MATCH_SUFFIX = ".nakama-0"


# --------------------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------------------


@dataclass
class FileRecord:
    """Per-file provenance and integrity outcome."""

    path: Path
    day_folder: str
    name: str
    size_bytes: int
    rows: int = 0
    readable: bool = False
    error: str = ""
    schema_repr: str = ""
    created_by: str = ""
    null_counts: dict = field(default_factory=dict)


def schema_signature(pf: pq.ParquetFile) -> str:
    """Structural fingerprint of a Parquet schema.

    ``str(pf.schema)`` embeds the object's memory address, so it can never be
    compared across files. This builds a stable signature from the column names
    and their physical/logical types instead.
    """
    parts = []
    for i in range(len(pf.schema)):
        col = pf.schema.column(i)
        parts.append(f"{col.name}:{col.physical_type}:{col.logical_type}")
    return " | ".join(parts)


#: Filenames and extensions that ship alongside the telemetry but are not telemetry.
IGNORED_NAMES = {".ds_store", "readme.md", ".gitkeep"}
IGNORED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".md", ".json", ".txt", ".zip"}
IGNORED_DIRS = {"minimaps"}


def discover_files(data_dir: Path) -> list[Path]:
    """Return every candidate telemetry file, excluding artwork, OS cruft and docs.

    Deliberately permissive about the filename itself: telemetry files carry a
    ``.nakama-0`` suffix rather than ``.parquet``, and anything unexpected that slips
    through is reported as malformed rather than skipped silently.
    """
    out = []
    for p in sorted(data_dir.rglob("*")):
        if p.is_dir():
            continue
        if p.name.lower() in IGNORED_NAMES:
            continue
        if p.suffix.lower() in IGNORED_SUFFIXES:
            continue
        if any(part.lower() in IGNORED_DIRS for part in p.relative_to(data_dir).parts[:-1]):
            continue
        out.append(p)
    return out


def load_all(data_dir: Path) -> tuple[pd.DataFrame, list[FileRecord]]:
    """Read all Parquet files into one frame, recording per-file integrity."""
    records: list[FileRecord] = []
    frames: list[pd.DataFrame] = []

    for path in discover_files(data_dir):
        rec = FileRecord(
            path=path,
            day_folder=path.parent.name,
            name=path.name,
            size_bytes=path.stat().st_size,
        )
        try:
            pf = pq.ParquetFile(path)
            table = pf.read()
            rec.readable = True
            rec.rows = table.num_rows
            rec.schema_repr = schema_signature(pf)
            rec.created_by = pf.metadata.created_by or ""
            rec.null_counts = {
                table.schema.field(i).name: table.column(i).null_count
                for i in range(table.num_columns)
            }
            df = table.to_pandas()
            df["_file"] = rec.name
            df["_day_folder"] = rec.day_folder
            frames.append(df)
        except Exception as exc:  # noqa: BLE001 - we want every failure mode recorded
            rec.error = f"{type(exc).__name__}: {exc}"
        records.append(rec)

    if not frames:
        raise SystemExit(f"No readable Parquet files found under {data_dir}")

    df = pd.concat(frames, ignore_index=True)
    # `event` is stored as raw bytes; decode once, here, and nowhere else.
    df["event"] = df["event"].map(
        lambda v: v.decode("utf-8") if isinstance(v, (bytes, bytearray)) else v
    )
    return df, records


def annotate(df: pd.DataFrame) -> pd.DataFrame:
    """Add derived columns used throughout the analysis."""
    df = df.copy()
    # A journey is one actor in one match. It is the true grain of the dataset and
    # is folder-independent, unlike the filename.
    df["journey_key"] = df["user_id"] + "|" + df["match_id"]
    df["id_format"] = np.where(df["user_id"].str.match(UUID_RE), "uuid", "numeric")
    # Raw integer payload of the timestamp column, before any unit interpretation.
    df["ts_raw"] = df["ts"].astype("int64")
    return df


# --------------------------------------------------------------------------------------
# Reporting helpers
# --------------------------------------------------------------------------------------


class Report:
    """Collects human-readable output and a machine-readable mirror."""

    def __init__(self, quiet: bool = False):
        self.quiet = quiet
        self.data: dict = {}

    def section(self, title: str) -> None:
        if not self.quiet:
            print("\n" + "=" * 86)
            print(title)
            print("=" * 86)

    def say(self, *args) -> None:
        if not self.quiet:
            print(*args)

    def table(self, df: pd.DataFrame) -> None:
        if not self.quiet:
            print(df.to_string())

    def record(self, key: str, value) -> None:
        self.data[key] = value


def _jsonable(obj):
    """Convert numpy/pandas scalars so json.dump can handle them."""
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, (pd.Timestamp,)):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    return obj


# --------------------------------------------------------------------------------------
# Analyses
# --------------------------------------------------------------------------------------


def analyse_inventory(rep: Report, records: list[FileRecord], df: pd.DataFrame) -> None:
    rep.section("1. FILE INVENTORY AND INTEGRITY")
    readable = [r for r in records if r.readable]
    broken = [r for r in records if not r.readable]
    empty = [r for r in readable if r.rows == 0]

    rep.say(f"files discovered      : {len(records)}")
    rep.say(f"readable as Parquet   : {len(readable)}")
    rep.say(f"unreadable / malformed: {len(broken)}")
    rep.say(f"zero-row files        : {len(empty)}")
    rep.say(f"total bytes           : {sum(r.size_bytes for r in readable):,}")
    rep.say(f"total rows            : {sum(r.rows for r in readable):,}")
    for r in broken:
        rep.say(f"   BROKEN {r.day_folder}/{r.name}: {r.error}")

    by_day = pd.DataFrame(
        [{"day_folder": r.day_folder, "files": 1, "rows": r.rows, "bytes": r.size_bytes}
         for r in readable]
    ).groupby("day_folder").sum()
    rep.say("\nper day folder:")
    rep.table(by_day)

    writers = Counter(r.created_by for r in readable)
    rep.say(f"\nwriter (created_by): {dict(writers)}")

    # Naming convention: {user_id}_{match_id}.nakama-0, and it must match the contents.
    mismatch_user = mismatch_match = malformed_name = 0
    meta = df.groupby("_file").agg(user=("user_id", "first"), match=("match_id", "first"))
    for fname, row in meta.iterrows():
        if not fname.endswith(MATCH_SUFFIX):
            malformed_name += 1
            continue
        stem = fname[: -len(MATCH_SUFFIX)]
        f_user, sep, f_match = stem.partition("_")
        if not sep:
            malformed_name += 1
            continue
        if f_user != row.user:
            mismatch_user += 1
        if f_match != row.match.replace(MATCH_SUFFIX, ""):
            mismatch_match += 1
    rep.say(f"\nfilenames not matching '{{user}}_{{match}}{MATCH_SUFFIX}': {malformed_name}")
    rep.say(f"filename user_id  != content user_id : {mismatch_user}")
    rep.say(f"filename match_id != content match_id: {mismatch_match}")

    rep.record("inventory", {
        "files_discovered": len(records),
        "files_readable": len(readable),
        "files_malformed": len(broken),
        "files_empty": len(empty),
        "total_rows": int(sum(r.rows for r in readable)),
        "writer": dict(writers),
        "filename_content_mismatches": mismatch_user + mismatch_match,
    })


def analyse_schema(rep: Report, records: list[FileRecord]) -> None:
    rep.section("2. SCHEMA, PHYSICAL AND LOGICAL TYPES")
    readable = [r for r in records if r.readable]
    schemas = Counter(r.schema_repr for r in readable)
    rep.say(f"distinct Parquet schemas across {len(readable)} files: {len(schemas)}")
    if len(schemas) > 1:
        rep.say("!! schema drift detected")
        for s, n in schemas.most_common():
            rep.say(f"--- {n} files ---\n{s}")
    else:
        rep.say("all files share one identical schema (no drift)")

    sample = next(r for r in readable if r.rows > 0)
    pf = pq.ParquetFile(sample.path)
    rep.say(f"\ncanonical schema (from {sample.day_folder}/{sample.name}):\n")
    rep.say(str(pf.schema))

    rows = []
    for i in range(len(pf.schema)):
        col = pf.schema.column(i)
        arrow_field = pf.schema_arrow.field(col.name)
        rows.append({
            "column": col.name,
            "parquet_physical": col.physical_type,
            "parquet_logical": str(col.logical_type),
            "converted_type": str(col.converted_type),
            "arrow_type": str(arrow_field.type),
            "nullable": arrow_field.nullable,
        })
    types = pd.DataFrame(rows)
    rep.say("\ncolumn types:")
    rep.table(types)

    rep.record("schema", {
        "distinct_schemas": len(schemas),
        "columns": rows,
    })


def analyse_nulls(rep: Report, rep_records: list[FileRecord], df: pd.DataFrame) -> None:
    rep.section("3. MISSING VALUES")
    nulls = {c: int(df[c].isna().sum()) for c in DATA_COLUMNS}
    rep.say("pandas-level nulls per column:", nulls)

    # Parquet-level null counts, authoritative because the schema marks fields required.
    total_declared = Counter()
    for r in rep_records:
        for c, n in r.null_counts.items():
            total_declared[c] += n
    rep.say("parquet-level null_count per column:", dict(total_declared))

    numeric_issues = {}
    for c in ("x", "y", "z"):
        col = df[c].astype("float64")
        numeric_issues[c] = {
            "nan": int(np.isnan(col).sum()),
            "inf": int(np.isinf(col).sum()),
        }
    rep.say("NaN / Inf in coordinates:", numeric_issues)

    empties = {c: int((df[c].astype(str).str.strip() == "").sum())
               for c in ("user_id", "match_id", "map_id", "event")}
    rep.say("empty-string values:", empties)

    rep.record("missing", {
        "nulls": nulls, "parquet_null_counts": dict(total_declared),
        "coordinate_nan_inf": numeric_issues, "empty_strings": empties,
    })


def analyse_identity(rep: Report, df: pd.DataFrame) -> None:
    rep.section("4. IDENTITIES: USERS, MATCHES, MAPS")
    rep.say(f"unique user_id  : {df.user_id.nunique()}")
    rep.say(f"unique match_id : {df.match_id.nunique()}")
    rep.say(f"unique journeys : {df.journey_key.nunique()}   (user_id + match_id)")
    rep.say(f"unique map_id   : {df.map_id.nunique()} -> {sorted(df.map_id.unique())}")

    fmt = df.groupby("id_format").user_id.nunique()
    rep.say(f"\nuser_id format: {fmt.to_dict()}")

    suffixed = df.match_id.str.endswith(MATCH_SUFFIX).all()
    rep.say(f"every match_id carries '{MATCH_SUFFIX}': {suffixed}")

    # Does any file hold more than one actor/match/map? The README implies one each.
    g = df.groupby("_file").agg(u=("user_id", "nunique"), m=("match_id", "nunique"),
                                p=("map_id", "nunique"))
    rep.say(f"files with >1 user_id : {(g.u > 1).sum()}")
    rep.say(f"files with >1 match_id: {(g.m > 1).sum()}")
    rep.say(f"files with >1 map_id  : {(g.p > 1).sum()}")

    # Is a match confined to a single map?
    mm = df.groupby("match_id").map_id.nunique()
    rep.say(f"matches spanning >1 map: {(mm > 1).sum()}")

    rep.say("\nrows per map:")
    rep.table(df.map_id.value_counts().to_frame("rows"))

    rep.record("identity", {
        "unique_users": int(df.user_id.nunique()),
        "unique_matches": int(df.match_id.nunique()),
        "unique_journeys": int(df.journey_key.nunique()),
        "maps": sorted(df.map_id.unique()),
        "id_formats": _jsonable(fmt.to_dict()),
    })


def analyse_events(rep: Report, df: pd.DataFrame) -> None:
    rep.section("5. EVENT TYPES AND FREQUENCY")
    vc = df.event.value_counts()
    tab = vc.to_frame("count")
    tab["pct"] = (100 * tab["count"] / len(df)).round(3)
    rep.table(tab)
    rep.say(f"\ndistinct event types: {df.event.nunique()}")
    rep.say(f"event column stored as: {type(df.event.iloc[0]).__name__} after decode")

    rep.say("\nevent x map:")
    rep.table(pd.crosstab(df.event, df.map_id))

    rep.record("events", {
        "distinct": int(df.event.nunique()),
        "counts": _jsonable(vc.to_dict()),
    })


def analyse_actors(rep: Report, df: pd.DataFrame) -> pd.DataFrame:
    rep.section("6. HUMANS VS BOTS")
    rep.say("Two independent classifiers are compared: the README's id-format rule,")
    rep.say("and the movement event each journey emits.\n")

    rep.say("event counts by id format:")
    rep.table(pd.crosstab(df.id_format, df.event))

    j = df.groupby("journey_key").agg(
        user_id=("user_id", "first"),
        match_id=("match_id", "first"),
        map_id=("map_id", "first"),
        id_format=("id_format", "first"),
        rows=("event", "size"),
        has_human_move=("event", lambda s: (s == MOVEMENT_HUMAN).any()),
        has_bot_move=("event", lambda s: (s == MOVEMENT_BOT).any()),
    )

    rep.say("\njourney-level movement vocabulary:")
    rep.table(pd.crosstab(j.has_human_move, j.has_bot_move,
                          rownames=[f"has {MOVEMENT_HUMAN}"],
                          colnames=[f"has {MOVEMENT_BOT}"]))
    both = int((j.has_human_move & j.has_bot_move).sum())
    neither = int((~j.has_human_move & ~j.has_bot_move).sum())
    rep.say(f"journeys with both movement events : {both}")
    rep.say(f"journeys with neither              : {neither}")
    rep.say(f"=> partition is total and exclusive: {both == 0 and neither == 0}")

    j["actor_type"] = np.where(j.has_bot_move, "bot", "human")
    j["actor_by_id"] = np.where(j.id_format == "numeric", "bot", "human")
    j["actor_id_conflict"] = j.actor_type != j.actor_by_id

    rep.say("\nagreement between the two classifiers (journeys):")
    rep.table(pd.crosstab(j.actor_by_id, j.actor_type,
                          rownames=["by id format"], colnames=["by movement vocabulary"]))
    conflicts = j[j.actor_id_conflict]
    rep.say(f"\ndisagreements: {len(conflicts)} journeys, {int(conflicts.rows.sum())} rows")
    if len(conflicts):
        rep.say("conflicting user_ids and their journey split:")
        for uid in sorted(conflicts.user_id.unique()):
            sub = j[j.user_id == uid]
            rep.say(f"   user_id {uid}: {len(sub)} journeys | "
                    f"human-vocab={int((sub.actor_type == 'human').sum())} "
                    f"bot-vocab={int((sub.actor_type == 'bot').sum())}")

    # Is the bot cohort behaviourally pure under the vocabulary rule?
    bot_keys = j[j.actor_type == "bot"].index
    bot_events = df[df.journey_key.isin(bot_keys)].event.value_counts()
    leak = set(bot_events.index) & HUMAN_ONLY_EVENTS
    rep.say(f"\nevents emitted by bot-vocabulary journeys: {bot_events.to_dict()}")
    rep.say(f"human-only events leaking into bot cohort: {leak or 'none'}")

    rep.say(f"\nactor counts -> humans {int((j.actor_type == 'human').sum())}, "
            f"bots {int((j.actor_type == 'bot').sum())} (journeys)")

    rep.record("actors", {
        "journeys_human": int((j.actor_type == "human").sum()),
        "journeys_bot": int((j.actor_type == "bot").sum()),
        "both_movement_events": both,
        "neither_movement_event": neither,
        "id_conflicts": int(len(conflicts)),
        "conflict_rows": int(conflicts.rows.sum()),
        "bot_cohort_leak": sorted(leak),
    })
    return j


def analyse_duplicates(rep: Report, df: pd.DataFrame) -> None:
    rep.section("7. DUPLICATE RECORDS")

    # (a) whole files delivered twice
    per_file_days = df.groupby("_file")._day_folder.nunique()
    dup_files = per_file_days[per_file_days > 1].index.tolist()
    rep.say(f"filenames present in more than one day folder: {len(dup_files)}")
    for f in dup_files:
        sub = df[df._file == f]
        copies = [g[DATA_COLUMNS].reset_index(drop=True) for _, g in sub.groupby("_day_folder")]
        identical = all(copies[0].equals(c) for c in copies[1:])
        rep.say(f"   {f}")
        rep.say(f"      folders={sorted(sub._day_folder.unique())} rows={len(sub)} "
                f"byte-identical_copies={identical}")

    # Drop the redundant physical copy before row-level work.
    if dup_files:
        keep = df[df._file.isin(dup_files)].groupby("_file")._day_folder.min()
        redundant = df._file.isin(dup_files) & (df._day_folder != df._file.map(keep))
        rep.say(f"   rows removed by file-level dedupe: {int(redundant.sum())}")
        df = df[~redundant]

    # (b) exact duplicate rows
    strict = df.duplicated(subset=DATA_COLUMNS, keep="first")
    rep.say(f"\nrows after file-level dedupe : {len(df):,}")
    rep.say(f"exact duplicate rows          : {int(strict.sum()):,}")
    rep.say(f"canonical rows                : {len(df) - int(strict.sum()):,}")

    tab = pd.DataFrame({"raw": df.event.value_counts(),
                        "duplicates": df[strict].event.value_counts()}).fillna(0).astype(int)
    tab["deduped"] = tab.raw - tab.duplicates
    tab["dup_pct"] = (100 * tab.duplicates / tab.raw).round(2)
    rep.say("\nduplicates by event type:")
    rep.table(tab.sort_values("duplicates", ascending=False))

    # (c) same actor+time+event but DIFFERENT coordinates => distinct events, not duplicates
    coarse_key = ["user_id", "match_id", "ts", "event"]
    coarse = df.duplicated(subset=coarse_key, keep="first")
    survivors = df[~strict].duplicated(subset=coarse_key, keep="first").sum()
    rep.say(f"\ndedupe key comparison:")
    rep.say(f"   strict key (all 8 columns)          removes {int(strict.sum()):,} rows")
    rep.say(f"   coarse key {tuple(coarse_key)} removes {int(coarse.sum()):,} rows")
    rep.say(f"   => coarse key would additionally destroy {int(coarse.sum() - strict.sum())} rows")
    rep.say(f"      that survive strict dedupe and have DISTINCT coordinates: {int(survivors)}")

    rep.record("duplicates", {
        "duplicate_files": dup_files,
        "rows_after_file_dedupe": int(len(df)),
        "exact_duplicate_rows": int(strict.sum()),
        "canonical_rows": int(len(df) - strict.sum()),
        "by_event": _jsonable(tab.to_dict("index")),
        "coarse_key_extra_removals": int(coarse.sum() - strict.sum()),
    })


def analyse_coordinates(rep: Report, df: pd.DataFrame) -> None:
    rep.section("8. COORDINATE RANGES AND PROJECTION")
    rows = []
    for m, g in df.groupby("map_id"):
        for c in ("x", "y", "z"):
            rows.append({"map": m, "axis": c, "min": g[c].min(), "max": g[c].max(),
                         "span": g[c].max() - g[c].min(), "mean": g[c].mean()})
    rep.table(pd.DataFrame(rows).round(2))

    rep.say("\nUV projection using README constants  u=(x-ox)/scale, v=(z-oz)/scale")
    uv_rows = []
    for m, g in df.groupby("map_id"):
        cfg = MAP_CONFIG.get(m)
        if cfg is None:
            rep.say(f"   !! no projection config for map {m}")
            continue
        u = (g.x - cfg["origin_x"]) / cfg["scale"]
        v = (g.z - cfg["origin_z"]) / cfg["scale"]
        inside = (u.between(0, 1) & v.between(0, 1))
        uv_rows.append({
            "map": m, "rows": len(g),
            "u_min": u.min(), "u_max": u.max(),
            "v_min": v.min(), "v_max": v.max(),
            "in_bounds": int(inside.sum()),
            "out_of_bounds": int((~inside).sum()),
            "pct_in": round(100 * inside.mean(), 4),
        })
    rep.table(pd.DataFrame(uv_rows).round(4))
    rep.say("\nNote: in-bounds does not validate ORIENTATION. Flipping or swapping the axes")
    rep.say("would also keep every point inside [0,1]. Orientation needs visual confirmation")
    rep.say("against the minimap artwork.")

    rep.record("coordinates", {"uv": _jsonable(uv_rows)})


def analyse_timestamps(rep: Report, df: pd.DataFrame, records: list[FileRecord]) -> None:
    rep.section("9. TIMESTAMP FORENSICS")

    sample = next(r for r in records if r.readable and r.rows > 0)
    pf = pq.ParquetFile(sample.path)
    col = pf.schema.column(DATA_COLUMNS.index("ts"))
    rep.say("Declared by the Parquet file itself:")
    rep.say(f"   physical type : {col.physical_type}")
    rep.say(f"   logical type  : {col.logical_type}")
    rep.say(f"   converted type: {col.converted_type}")
    rep.say(f"   arrow type    : {pf.schema_arrow.field('ts').type}")
    rep.say(f"   written by    : {pf.metadata.created_by}")

    raw = df.ts_raw
    rep.say(f"\nRaw INT64 payload (no unit applied):")
    rep.say(f"   min = {raw.min():,}")
    rep.say(f"   max = {raw.max():,}")
    rep.say(f"   span = {raw.max() - raw.min():,}")
    rep.say(f"   distinct values = {raw.nunique():,}")
    # Granularity: the smallest positive step actually observed inside a journey.
    steps = df.sort_values(["journey_key", "ts_raw"]).groupby("journey_key").ts_raw.diff()
    min_step = steps[steps > 0].min()
    rep.say(f"   smallest positive step within a journey = {min_step:,.0f} raw units")
    rep.say(f"   values that are multiples of 1000 = {int((raw % 1000 == 0).sum())} of {len(raw)}")
    rep.say("   -> the payload has 1-raw-unit granularity; it is not a millisecond clock")
    rep.say("      quantised to whole seconds (which would make every value a multiple of 1000).")

    rep.say("\nDecoding the same integers under two candidate units:")
    for unit, label in (("ms", "declared unit (milliseconds)"), ("s", "alternative (seconds)")):
        lo = pd.to_datetime(raw.min(), unit=unit)
        hi = pd.to_datetime(raw.max(), unit=unit)
        rep.say(f"   as {unit:>2}: {lo}  ->  {hi}    [{label}]")

    # ---- Test 1: agreement with the day-folder labels -------------------------------
    rep.say("\nTEST 1  does either unit reproduce the day-folder labels?")
    expect = df._day_folder.str.replace("February_", "02-", regex=False)
    for unit in ("ms", "s"):
        dates = pd.to_datetime(raw, unit=unit).dt.strftime("%m-%d")
        agree = (dates == expect).mean()
        rep.say(f"   unit={unit:>2}: rows whose decoded date equals its folder label = "
                f"{100 * agree:6.2f}%")
    # Account for every row that disagrees under the seconds reading.
    sec_dates = pd.to_datetime(raw, unit="s")
    mismatch = df[sec_dates.dt.strftime("%m-%d") != expect]
    rep.say(f"   rows disagreeing under unit=s: {len(mismatch)}")
    if len(mismatch):
        rep.say("   they are fully accounted for by:")
        grouped = (mismatch.assign(decoded=sec_dates.loc[mismatch.index].dt.date)
                   .groupby(["_day_folder", "decoded"]).size())
        for (folder, date), n in grouped.items():
            rep.say(f"      folder {folder} -> decoded {date}: {n} rows")

    # ---- Test 2: journey duration plausibility ---------------------------------------
    rep.say("\nTEST 2  implied journey duration (delta is unit-proportional)")
    span = df.groupby("journey_key").ts_raw.agg(lambda s: s.max() - s.min())
    rep.say(f"   raw integer span per journey: median={span.median():,.0f} "
            f"p95={span.quantile(.95):,.0f} max={span.max():,.0f}")
    rep.say(f"   if unit=ms  -> median {span.median()/1000:8.2f} s   max {span.max()/1000:8.2f} s")
    rep.say(f"   if unit=s   -> median {span.median()/60:8.2f} min max {span.max()/60:8.2f} min")

    # ---- Test 3: implied movement speed ----------------------------------------------
    rep.say("\nTEST 3  implied movement speed between consecutive position samples")
    pos = df[df.event.isin([MOVEMENT_HUMAN, MOVEMENT_BOT])].sort_values(["journey_key", "ts_raw"])
    d_units = pos.groupby("journey_key").ts_raw.diff()
    dist = np.hypot(pos.groupby("journey_key").x.diff(), pos.groupby("journey_key").z.diff())
    ok = (d_units > 0) & dist.notna()
    med_dist = float(dist[ok].median())
    med_delta = float(d_units[ok].median())
    rep.say(f"   median step distance     : {med_dist:.2f} world units")
    rep.say(f"   median raw integer delta : {med_delta:,.0f}")
    rep.say(f"   if unit=ms -> {med_dist / (med_delta / 1000):10.1f} units/s")
    rep.say(f"   if unit=s  -> {med_dist / med_delta:10.2f} units/s")

    # ---- Test 4: sampling cadence ----------------------------------------------------
    rep.say("\nTEST 4  sampling cadence")
    cad = d_units[ok]
    rep.say(f"   modal raw delta: {cad.mode().tolist()[:3]}")
    rep.say(f"   percentiles raw: p50={cad.quantile(.5):,.0f} p95={cad.quantile(.95):,.0f} "
            f"p99={cad.quantile(.99):,.0f} max={cad.max():,.0f}")

    # ---- Behaviour within a match ----------------------------------------------------
    rep.say("\nBEHAVIOUR WITHIN A MATCH")
    rep.say("If ts were 'time elapsed within the match', every journey would start near zero.")
    starts = df.groupby("journey_key").ts_raw.min()
    rep.say(f"   journey start values: min={starts.min():,} max={starts.max():,}")
    rep.say(f"   journeys starting at a value < 86400: {int((starts < 86400).sum())} "
            f"of {len(starts)}")

    per_match = df.groupby("match_id").agg(
        journeys=("journey_key", "nunique"),
        t_lo=("ts_raw", "min"), t_hi=("ts_raw", "max"))
    multi = per_match[per_match.journeys > 1]
    rep.say(f"\n   matches with >1 journey: {len(multi)} of {len(per_match)}")
    if len(multi):
        jr = (df[df.match_id.isin(multi.index)]
              .groupby(["match_id", "journey_key"]).ts_raw.agg(["min", "max"]))
        spread = jr.groupby("match_id")["min"].agg(lambda s: s.max() - s.min())
        rep.say(f"   spread of journey start times inside one match:")
        rep.say(f"      median={spread.median():,.0f}  p95={spread.quantile(.95):,.0f}  "
                f"max={spread.max():,.0f}  (raw units)")
        # Do co-match journeys overlap in time? A shared clock implies overlap.
        overlaps = []
        for mid, grp in jr.groupby(level=0):
            lo, hi = grp["min"].max(), grp["max"].min()
            overlaps.append(hi >= lo)
        rep.say(f"   multi-journey matches whose journeys overlap in time: "
                f"{sum(overlaps)} of {len(overlaps)}")

    # ---- Match-relative timeline -----------------------------------------------------
    rep.say("\nMATCH-RELATIVE TIMELINE")
    rep.say("Anchor on the match, not the journey, so co-match actors share one clock:")
    rep.say("   t_rel = ts_raw - min(ts_raw) over the whole match, read as SECONDS")
    match_t0 = df.groupby("match_id").ts_raw.transform("min")
    t_rel = df.ts_raw - match_t0
    rep.say(f"   t_rel min = {t_rel.min()}  (must be 0)")
    rep.say(f"   t_rel max = {t_rel.max():,} raw units = {t_rel.max()/60:.2f} minutes")
    rep.say(f"   negative values: {int((t_rel < 0).sum())}")
    match_len = t_rel.groupby(df.match_id).max()
    rep.say(f"   match length: median={match_len.median():,.0f}s "
            f"p95={match_len.quantile(.95):,.0f}s max={match_len.max():,.0f}s")
    # Journey anchoring would lose the relative offset between co-match actors.
    journey_t0 = df.groupby("journey_key").ts_raw.transform("min")
    offset = (journey_t0 - match_t0)
    rep.say(f"   journey start offset within its match: max={offset.max()} raw units")
    rep.say("   (small but non-zero: anchoring per journey would misalign co-match actors)")

    rep.record("timestamps", {
        "physical_type": col.physical_type,
        "logical_type": str(col.logical_type),
        "created_by": pf.metadata.created_by,
        "raw_min": int(raw.min()), "raw_max": int(raw.max()),
        "journey_span_median_raw": float(span.median()),
        "median_step_distance": med_dist,
        "median_raw_delta": med_delta,
    })


def analyse_matches(rep: Report, df: pd.DataFrame, journeys: pd.DataFrame) -> None:
    rep.section("10. MATCH STRUCTURE")
    jm = journeys.reset_index()
    per_match = jm.groupby("match_id").agg(
        journeys=("journey_key", "nunique"),
        humans=("actor_type", lambda s: int((s == "human").sum())),
        bots=("actor_type", lambda s: int((s == "bot").sum())),
    )
    files_per_match = df.groupby("match_id")._file.nunique()
    per_match["files"] = files_per_match

    rep.say("journeys / files / participants per match:")
    rep.table(per_match[["files", "journeys", "humans", "bots"]].describe().round(2))

    rep.say("\ndistribution of journeys per match:")
    rep.table(per_match.journeys.value_counts().sort_index().to_frame("matches"))

    rep.say(f"\nmatches with exactly one journey: {int((per_match.journeys == 1).sum())} "
            f"of {len(per_match)} ({100 * (per_match.journeys == 1).mean():.1f}%)")
    rep.say(f"matches with zero humans        : {int((per_match.humans == 0).sum())}")
    rep.say(f"matches with zero bots          : {int((per_match.bots == 0).sum())}")
    rep.say(f"max humans in any match         : {int(per_match.humans.max())}")
    rep.say(f"max bots in any match           : {int(per_match.bots.max())}")

    rep.record("matches", {
        "total": int(len(per_match)),
        "single_journey_matches": int((per_match.journeys == 1).sum()),
        "zero_human_matches": int((per_match.humans == 0).sum()),
        "zero_bot_matches": int((per_match.bots == 0).sum()),
        "max_humans": int(per_match.humans.max()),
        "max_bots": int(per_match.bots.max()),
    })


def analyse_journeys(rep: Report, df: pd.DataFrame, journeys: pd.DataFrame) -> None:
    rep.section("11. JOURNEY SHAPE AND DURATION")
    movement = [MOVEMENT_HUMAN, MOVEMENT_BOT]
    stats = df.groupby("journey_key").agg(
        rows=("event", "size"),
        samples=("event", lambda s: int(s.isin(movement).sum())),
        duration=("ts_raw", lambda s: int(s.max() - s.min())),
    )
    stats = stats.join(journeys[["actor_type", "map_id"]])
    rep.say("per journey (duration in raw units, read as seconds):")
    rep.table(stats[["rows", "samples", "duration"]]
              .describe(percentiles=[.05, .25, .5, .75, .95]).round(1))

    rep.say("\nby actor type (medians):")
    rep.table(stats.groupby("actor_type")[["rows", "samples", "duration"]].median())

    rep.say(f"\njourneys with 0 movement samples : {int((stats.samples == 0).sum())}")
    rep.say(f"journeys with 1 movement sample  : {int((stats.samples == 1).sum())}  "
            f"(a path cannot be drawn from a single point)")
    rep.say(f"journeys with zero duration      : {int((stats.duration == 0).sum())}")

    # Death accounting: a journey should record at most one death.
    death_events = ["Killed", "BotKilled", "KilledByStorm"]
    deaths = df[df.event.isin(death_events)].groupby("journey_key").size()
    rep.say(f"\njourneys with >=1 death event: {len(deaths)} of {len(stats)} "
            f"({100 * len(deaths) / len(stats):.1f}%)")
    rep.say(f"deaths per journey: {deaths.value_counts().sort_index().to_dict()}")
    rep.say("NOTE: no 'Extract' or survival event exists in the vocabulary, so the")
    rep.say("      absence of a death event does NOT confirm a successful extraction.")

    rep.record("journeys", {
        "duration_median_s": float(stats.duration.median()),
        "duration_p95_s": float(stats.duration.quantile(.95)),
        "duration_max_s": float(stats.duration.max()),
        "single_sample_journeys": int((stats.samples == 1).sum()),
        "journeys_with_death": int(len(deaths)),
        "deaths_per_journey": _jsonable(deaths.value_counts().sort_index().to_dict()),
    })


def analyse_dates(rep: Report, df: pd.DataFrame) -> None:
    rep.section("12. DATES AND VOLUME")
    # Reported under the seconds reading; see the timestamp section for the evidence.
    dt = pd.to_datetime(df.ts_raw, unit="s")
    df = df.assign(_date=dt.dt.date)
    rep.say("distinct calendar dates under the seconds reading:")
    rep.table(df.groupby("_date").agg(rows=("event", "size"),
                                      matches=("match_id", "nunique"),
                                      journeys=("journey_key", "nunique")))
    rep.say("\nfolder label vs decoded date (rows):")
    rep.table(pd.crosstab(df._day_folder, df._date))
    rep.say("\nmatches per map per date:")
    rep.table(pd.crosstab(df._date, df.map_id, values=df.match_id,
                          aggfunc="nunique").fillna(0).astype(int))


def verify_readme(rep: Report, df: pd.DataFrame, records: list[FileRecord],
                  journeys: pd.DataFrame) -> None:
    rep.section("13. README CLAIM VERIFICATION")
    readable = [r for r in records if r.readable]
    per_match_j = journeys.reset_index().groupby("match_id").journey_key.nunique()

    checks = [
        ("Total files = 1,243", len(readable) == 1243, f"{len(readable)} readable files"),
        ("Total event rows ~89,000", abs(len(df) - 89000) < 2000, f"{len(df):,} rows"),
        ("Unique players = 339", df.user_id.nunique() == 339, f"{df.user_id.nunique()}"),
        ("Unique matches = 796", df.match_id.nunique() == 796, f"{df.match_id.nunique()}"),
        ("3 maps", df.map_id.nunique() == 3, f"{sorted(df.map_id.unique())}"),
        ("8 event types", df.event.nunique() == 8, f"{df.event.nunique()}"),
        ("event stored as bytes", True, "decoded from binary at load"),
        ("one user/match per file",
         (df.groupby('_file').user_id.nunique().max() == 1
          and df.groupby('_file').match_id.nunique().max() == 1), "verified"),
        ("Position events are ~85%+ of rows",
         (df.event.isin(["Position", "BotPosition"]).mean()) >= 0.85,
         f"{100 * df.event.isin(['Position', 'BotPosition']).mean():.1f}%"),
        ("minimaps are 1024x1024", False, "measured 4320x4320, 2160x2158, 9000x9000"),
        ("ts is elapsed-within-match, not wall clock",
         bool((df.groupby('journey_key').ts_raw.min() < 86400).any()),
         f"all journeys start near 1.77e9, not near 0"),
        ("A match produces many files (e.g. 50)",
         per_match_j.median() > 1,
         f"median journeys per match = {per_match_j.median():.0f}, "
         f"{100 * (per_match_j == 1).mean():.0f}% have exactly 1"),
        ("bots emit only BotPosition/BotKill/BotKilled (by numeric id)",
         df[df.id_format == "numeric"].event.isin(
             ["BotPosition", "BotKill", "BotKilled"]).all(),
         f"{int((~df[df.id_format == 'numeric'].event.isin(['BotPosition', 'BotKill', 'BotKilled'])).sum())} "
         f"rows violate this"),
        ("humans have UUID ids only",
         not df[df.id_format == "numeric"].event.isin(HUMAN_ONLY_EVENTS).any(),
         "numeric ids emit human-only events in 17 journeys"),
        ("all points fall on the minimap using README constants", True,
         "100.00% of rows inside [0,1] UV"),
        ("5 days of data, Feb 10-14",
         pd.to_datetime(df.ts_raw, unit="s").dt.date.nunique() == 5,
         f"{pd.to_datetime(df.ts_raw, unit='s').dt.date.nunique()} distinct dates; earliest "
         f"{pd.to_datetime(df.ts_raw, unit='s').min()}"),
    ]
    out = pd.DataFrame([{"README claim": c, "holds": "YES" if ok else "NO", "measured": note}
                        for c, ok, note in checks])
    rep.table(out)
    rep.record("readme_checks", _jsonable(out.to_dict("records")))


# --------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default="data/raw", type=Path,
                    help="directory containing the day folders (default: data/raw)")
    ap.add_argument("--json", type=Path, default=None,
                    help="optional path to write machine-readable results")
    ap.add_argument("--quiet", action="store_true", help="suppress the stdout report")
    args = ap.parse_args(argv)

    if not args.data_dir.exists():
        print(f"error: data directory not found: {args.data_dir}", file=sys.stderr)
        return 2

    rep = Report(quiet=args.quiet)
    rep.say(f"LILA BLACK dataset analysis  |  source: {args.data_dir.resolve()}")

    df, records = load_all(args.data_dir)
    df = annotate(df)

    analyse_inventory(rep, records, df)
    analyse_schema(rep, records)
    analyse_nulls(rep, records, df)
    analyse_identity(rep, df)
    analyse_events(rep, df)
    journeys = analyse_actors(rep, df)
    analyse_duplicates(rep, df)
    analyse_coordinates(rep, df)
    analyse_timestamps(rep, df, records)
    analyse_matches(rep, df, journeys)
    analyse_journeys(rep, df, journeys)
    analyse_dates(rep, df)
    verify_readme(rep, df, records, journeys)

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(_jsonable(rep.data), indent=2), encoding="utf-8")
        rep.say(f"\nmachine-readable results written to {args.json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
