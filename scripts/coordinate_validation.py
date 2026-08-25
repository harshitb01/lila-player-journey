"""Validate the world-to-minimap coordinate transformation against real telemetry.

Mirrors `src/utils/coordinates.ts` exactly. The two implementations are held in sync by
a generated fixture (`--emit-fixture`) that the TypeScript test suite asserts against,
so the offline pipeline and the browser renderer cannot silently diverge.

Nothing is clamped anywhere in this script. Out-of-range results are reported, counted
and investigated, never absorbed.

Usage:
    python scripts/coordinate_validation.py
    python scripts/coordinate_validation.py --overlays --minimap-dir path/to/minimaps
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze_dataset import annotate, load_all  # noqa: E402

# --------------------------------------------------------------------------------------
# The transform, in isolation. Mirror of src/utils/coordinates.ts
# --------------------------------------------------------------------------------------

#: Reference resolution used by the README's worked example. NOT the size of any
#: shipped minimap image.
REFERENCE_SIZE = 1024


@dataclass(frozen=True)
class MapConfig:
    """Projection constants for one map, transcribed from the dataset README."""

    id: str
    scale: float
    origin_x: float
    origin_z: float


MAP_CONFIGS: dict[str, MapConfig] = {
    "AmbroseValley": MapConfig("AmbroseValley", 900, -370, -473),
    "GrandRift": MapConfig("GrandRift", 581, -290, -290),
    "Lockdown": MapConfig("Lockdown", 1000, -500, -500),
}

#: Measured pixel dimensions of the shipped minimap artwork. The README claims all
#: three are 1024x1024; none of them are, and GrandRift is not square.
MINIMAP_FILES = {
    "AmbroseValley": ("AmbroseValley_Minimap.png", 4320, 4320),
    "GrandRift": ("GrandRift_Minimap.png", 2160, 2158),
    "Lockdown": ("Lockdown_Minimap.jpg", 9000, 9000),
}


def world_to_uv(x, z, config: MapConfig):
    """u = (x - origin_x) / scale ; v = (z - origin_z) / scale. Never clamped."""
    return (x - config.origin_x) / config.scale, (z - config.origin_z) / config.scale


def uv_to_pixel(u, v, width=REFERENCE_SIZE, height=REFERENCE_SIZE):
    """pixel_x = u * width ; pixel_y = (1 - v) * height. Image origin is top-left."""
    return u * width, (1.0 - v) * height


def world_to_pixel(x, z, config: MapConfig, width=REFERENCE_SIZE, height=REFERENCE_SIZE):
    u, v = world_to_uv(x, z, config)
    return uv_to_pixel(u, v, width, height)


# --------------------------------------------------------------------------------------
# Candidate orientations, for the question in-bounds testing cannot answer
# --------------------------------------------------------------------------------------

#: Every one of these keeps points inside the image; only artwork can distinguish them.
ORIENTATIONS = {
    "documented": lambda u, v, w, h: (u * w, (1 - v) * h),
    "no_v_flip": lambda u, v, w, h: (u * w, v * h),
    "u_flipped": lambda u, v, w, h: ((1 - u) * w, (1 - v) * h),
    "axes_swapped": lambda u, v, w, h: (v * w, (1 - u) * h),
}


# --------------------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------------------


def check_readme_example() -> dict:
    """Reproduce the worked example printed in the dataset README, exactly."""
    print("=" * 86)
    print("1. README WORKED EXAMPLE")
    print("=" * 86)
    x, z = -301.45, -355.55
    cfg = MAP_CONFIGS["AmbroseValley"]
    u, v = world_to_uv(x, z, cfg)
    px, py = uv_to_pixel(u, v)

    print(f"input : AmbroseValley  x={x}  z={z}")
    print(f"        scale={cfg.scale} origin=({cfg.origin_x}, {cfg.origin_z})")
    print(f"computed u = ({x} - ({cfg.origin_x})) / {cfg.scale} = {u:.6f}")
    print(f"computed v = ({z} - ({cfg.origin_z})) / {cfg.scale} = {v:.6f}")
    print(f"computed pixel_x = {u:.6f} * 1024 = {px:.4f}  -> rounded {round(px)}")
    print(f"computed pixel_y = (1 - {v:.6f}) * 1024 = {py:.4f}  -> rounded {round(py)}")
    print()
    print("README states: u=0.0762  v=0.1305  pixel_x=78  pixel_y=890")

    ok = (
        abs(u - 0.0762) < 5e-5
        and abs(v - 0.1305) < 5e-5
        and round(px) == 78
        and round(py) == 890
    )
    print(f"MATCH: {'YES' if ok else 'NO'}")
    return {"u": u, "v": v, "pixel_x": px, "pixel_y": py, "matches_readme": ok}


def check_dataset(df: pd.DataFrame) -> dict:
    """Project every real telemetry row and count what lands off the minimap."""
    print()
    print("=" * 86)
    print("2. ALL REAL POSITIONS, EVERY MAP")
    print("=" * 86)

    rows = []
    per_map_detail = {}
    for map_id, g in df.groupby("map_id"):
        cfg = MAP_CONFIGS.get(map_id)
        if cfg is None:
            raise SystemExit(f"No projection config for map_id {map_id!r}")
        u, v = world_to_uv(g.x.to_numpy(), g.z.to_numpy(), cfg)
        px, py = uv_to_pixel(u, v)

        inside_uv = (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
        inside_px = (px >= 0) & (px <= REFERENCE_SIZE) & (py >= 0) & (py <= REFERENCE_SIZE)

        rows.append({
            "map": map_id,
            "points": len(g),
            "u_min": u.min(), "u_max": u.max(),
            "v_min": v.min(), "v_max": v.max(),
            "px_min": px.min(), "px_max": px.max(),
            "py_min": py.min(), "py_max": py.max(),
            "in_bounds": int(inside_px.sum()),
            "out_of_bounds": int((~inside_px).sum()),
            "pct_in": 100.0 * inside_px.mean(),
            "pct_out": 100.0 * (~inside_px).mean(),
        })
        per_map_detail[map_id] = {
            "u": u, "v": v, "px": px, "py": py,
            "inside": inside_px, "frame": g,
        }
        assert np.array_equal(inside_uv, inside_px), "UV and pixel bounds must agree"

    summary = pd.DataFrame(rows)
    print("\nUV extent and pixel extent per map (pixel space = 1024 reference square):")
    print(summary[["map", "points", "u_min", "u_max", "v_min", "v_max"]]
          .round(4).to_string(index=False))
    print()
    print(summary[["map", "px_min", "px_max", "py_min", "py_max"]]
          .round(2).to_string(index=False))

    print("\nIn-range vs out-of-range, per map:")
    print(summary[["map", "points", "in_bounds", "out_of_bounds", "pct_in", "pct_out"]]
          .round(4).to_string(index=False))

    total = int(summary.points.sum())
    total_in = int(summary.in_bounds.sum())
    total_out = int(summary.out_of_bounds.sum())
    print(f"\nOVERALL: {total_in:,} of {total:,} points inside [0,1024] "
          f"= {100.0 * total_in / total:.4f}%")
    print(f"         {total_out:,} outside = {100.0 * total_out / total:.4f}%")

    print("\nGlobal mapped-coordinate extremes (across all maps):")
    print(f"   pixel_x min = {summary.px_min.min():.4f}   max = {summary.px_max.max():.4f}")
    print(f"   pixel_y min = {summary.py_min.min():.4f}   max = {summary.py_max.max():.4f}")

    return {"summary": summary, "detail": per_map_detail,
            "total": total, "total_in": total_in, "total_out": total_out}


def investigate_out_of_range(result: dict) -> None:
    """Work through the four candidate explanations for off-map points."""
    print()
    print("=" * 86)
    print("3. OUT-OF-RANGE INVESTIGATION")
    print("=" * 86)

    if result["total_out"] == 0:
        print("No out-of-range points exist. All four candidate explanations are")
        print("vacuous for this dataset:")
        print("   (a) expected edge behaviour  -> nothing sits beyond an edge")
        print("   (b) invalid telemetry        -> no coordinate escapes its map bounds")
        print("   (c) incorrect mapping        -> no scale/origin error is detectable")
        print("   (d) wrong map assignment     -> tested separately below")
    else:
        for map_id, d in result["detail"].items():
            bad = d["frame"][~d["inside"]]
            if not len(bad):
                continue
            print(f"\n{map_id}: {len(bad)} out-of-range points")
            print(bad.event.value_counts().to_string())

    # (d) Wrong map assignment: would another map's constants fit a journey better?
    print()
    print("Cross-map test — would any map's points fit a DIFFERENT map's constants?")
    print("(if a journey were labelled with the wrong map, its own constants would")
    print(" likely push points off-map while another map's would contain them)")
    header = f"{'points from':<16}" + "".join(f"{m:>16}" for m in MAP_CONFIGS)
    print(header)
    for map_id, d in result["detail"].items():
        g = d["frame"]
        cells = []
        for other_id, other_cfg in MAP_CONFIGS.items():
            u, v = world_to_uv(g.x.to_numpy(), g.z.to_numpy(), other_cfg)
            pct = 100.0 * ((u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)).mean()
            cells.append(f"{pct:>15.2f}%")
        print(f"{map_id:<16}" + "".join(cells))
    print("\nA map's own constants must contain 100% of its points. Values under other")
    print("maps' constants are informational: overlap is expected where world extents")
    print("happen to intersect, and does not by itself indicate a mislabelled map.")


def check_coverage(result: dict) -> None:
    """How much of each minimap does the telemetry actually reach?"""
    print()
    print("=" * 86)
    print("4. COVERAGE OF THE MAPPED AREA")
    print("=" * 86)
    print("Fraction of the [0,1] UV square spanned by observed play:\n")
    for map_id, d in result["detail"].items():
        u, v = d["u"], d["v"]
        span_u, span_v = u.max() - u.min(), v.max() - v.min()
        print(f"{map_id:<15} u span {span_u:.4f}  v span {span_v:.4f}  "
              f"bounding box = {100 * span_u * span_v:5.1f}% of the image")
    print("\nUnreached area is NOT evidence of a projection error: it is equally")
    print("consistent with unplayable terrain, storm-restricted zones, or genuinely")
    print("ignored space. Distinguishing those requires the artwork, not the numbers.")


def emit_fixture(path: Path, df: pd.DataFrame, n_per_map: int, seed: int) -> None:
    """Write cross-language parity vectors for the TypeScript test suite."""
    rng = np.random.default_rng(seed)
    vectors = []
    for map_id, g in df.groupby("map_id"):
        cfg = MAP_CONFIGS[map_id]
        take = g.iloc[rng.choice(len(g), size=min(n_per_map, len(g)), replace=False)]
        for r in take.itertuples():
            u, v = world_to_uv(float(r.x), float(r.z), cfg)
            px, py = uv_to_pixel(u, v)
            vectors.append({
                "mapId": map_id,
                "x": float(r.x), "z": float(r.z),
                "u": u, "v": v, "pixelX": px, "pixelY": py,
            })
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "generatedBy": "scripts/coordinate_validation.py",
        "referenceSize": REFERENCE_SIZE,
        "seed": seed,
        "vectors": vectors,
    }, indent=2), encoding="utf-8")
    print(f"\nwrote {len(vectors)} parity vectors -> {path}")


def score_orientations(result: dict, minimap_dir: Path, dark_threshold: int) -> dict:
    """Score each candidate orientation against the artwork, objectively.

    Every minimap is surrounded by a near-black out-of-play margin. A correct
    projection should place almost no telemetry there, while a wrong one drops points
    into the void. Sampling the underlying pixel for every point turns the orientation
    question from a judgement call into a measurement.
    """
    from PIL import Image

    print()
    print("=" * 86)
    print("5. ORIENTATION TEST (objective)")
    print("=" * 86)
    print(f"Metric: % of points landing on out-of-play pixels "
          f"(luminance < {dark_threshold}).")
    print("Lower is better. A correct projection keeps play inside the playable area.\n")

    Image.MAX_IMAGE_PIXELS = None
    scores: dict[str, dict[str, float]] = {}

    for map_id, d in result["detail"].items():
        fname, _, _ = MINIMAP_FILES[map_id]
        src = minimap_dir / fname
        if not src.exists():
            print(f"   !! minimap not found: {src}")
            continue
        img = Image.open(src).convert("L")
        img.thumbnail((2048, 2048), Image.LANCZOS)
        lum = np.asarray(img, dtype=np.int16)
        h, w = lum.shape

        scores[map_id] = {}
        for name, fn in ORIENTATIONS.items():
            px, py = fn(d["u"], d["v"], w, h)
            xi = np.clip(px.astype(int), 0, w - 1)   # clamp for SAMPLING only
            yi = np.clip(py.astype(int), 0, h - 1)   # never for output geometry
            dark = (lum[yi, xi] < dark_threshold).mean() * 100.0
            scores[map_id][name] = float(dark)

    header = f"{'map':<16}" + "".join(f"{n:>16}" for n in ORIENTATIONS)
    print(header)
    for map_id, row in scores.items():
        best = min(row, key=row.get)
        cells = "".join(
            f"{row[n]:>14.2f}%" + ("*" if n == best else " ") for n in ORIENTATIONS
        )
        print(f"{map_id:<16}{cells}")
    print("\n(* = lowest, i.e. best fit for that map)")

    winners = {m: min(r, key=r.get) for m, r in scores.items()}
    print(f"\nbest orientation per map: {winners}")
    unanimous = len(set(winners.values())) == 1
    print(f"unanimous across all three maps: {unanimous}"
          + (f" -> '{next(iter(winners.values()))}'" if unanimous else ""))
    return {"scores": scores, "winners": winners, "unanimous": unanimous}


def render_overlays(result: dict, minimap_dir: Path, out_dir: Path, size: int) -> None:
    """Draw telemetry over each minimap under every candidate orientation.

    In-bounds arithmetic cannot distinguish these; only visual agreement with the
    artwork can. This produces the images that decide it.
    """
    from PIL import Image, ImageDraw

    print()
    print("=" * 86)
    print("5. ORIENTATION OVERLAYS")
    print("=" * 86)
    out_dir.mkdir(parents=True, exist_ok=True)

    for map_id, d in result["detail"].items():
        fname, _, _ = MINIMAP_FILES[map_id]
        src = minimap_dir / fname
        if not src.exists():
            print(f"   !! minimap not found: {src}")
            continue
        Image.MAX_IMAGE_PIXELS = None
        base = Image.open(src).convert("RGB")
        base.thumbnail((size, size), Image.LANCZOS)
        w, h = base.size

        u, v = d["u"], d["v"]
        for name, fn in ORIENTATIONS.items():
            canvas = base.copy()
            layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(layer)
            px, py = fn(u, v, w, h)
            for a, b in zip(px, py):
                draw.point((a, b), fill=(255, 60, 0, 190))
            canvas = Image.alpha_composite(canvas.convert("RGBA"), layer).convert("RGB")
            dest = out_dir / f"{map_id}_{name}.png"
            canvas.save(dest, optimize=True)
            print(f"   {dest}  ({w}x{h}, {len(u):,} points)")


# --------------------------------------------------------------------------------------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", type=Path, default=Path("data/raw"))
    ap.add_argument("--minimap-dir", type=Path, default=Path("data/raw/minimaps"))
    ap.add_argument("--out-dir", type=Path, default=Path("out/coordinate_validation"))
    ap.add_argument("--fixture", type=Path,
                    default=Path("src/utils/__fixtures__/projection-vectors.json"))
    ap.add_argument("--fixture-samples", type=int, default=200)
    ap.add_argument("--seed", type=int, default=20260214)
    ap.add_argument("--overlays", action="store_true",
                    help="render orientation overlays (requires Pillow and minimaps)")
    ap.add_argument("--overlay-size", type=int, default=1400)
    ap.add_argument("--dark-threshold", type=int, default=28,
                    help="luminance below which a pixel counts as out-of-play")
    args = ap.parse_args(argv)

    if not args.data_dir.exists():
        print(f"error: data directory not found: {args.data_dir}", file=sys.stderr)
        return 2

    print(f"Coordinate validation  |  source: {args.data_dir.resolve()}\n")
    df = annotate(load_all(args.data_dir)[0])

    readme = check_readme_example()
    result = check_dataset(df)
    investigate_out_of_range(result)
    check_coverage(result)
    emit_fixture(args.fixture, df, args.fixture_samples, args.seed)

    orient = score_orientations(result, args.minimap_dir, args.dark_threshold)

    if args.overlays:
        render_overlays(result, args.minimap_dir, args.out_dir, args.overlay_size)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "summary.json").write_text(json.dumps({
        "readme_example": {k: (bool(v) if isinstance(v, (bool, np.bool_)) else float(v))
                           for k, v in readme.items()},
        "total_points": result["total"],
        "in_bounds": result["total_in"],
        "out_of_bounds": result["total_out"],
        "per_map": json.loads(result["summary"].to_json(orient="records")),
        "orientation": orient,
    }, indent=2), encoding="utf-8")

    print()
    print("=" * 86)
    verdict = result["total_out"] == 0 and readme["matches_readme"]
    print(f"VERDICT: documented transform reproduces the README example and contains "
          f"{'ALL' if verdict else 'NOT ALL'} real points.")
    print("=" * 86)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
