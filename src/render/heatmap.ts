/**
 * Spatial aggregation for the heatmap layer.
 *
 * A plain grid over UV space, not a third-party heatmap library. Three reasons:
 * the points are already normalised to [0,1]² by the validated projection, so binning is
 * a multiply and a floor; alignment with the minimap is then automatic rather than
 * something to reconcile; and the whole thing is ~150 lines that can be unit-tested,
 * where a library would add a dependency and its own coordinate conventions to keep in
 * sync with ours.
 *
 * **What this is.** A relative-intensity field for *investigating* where things happen.
 * It is not a density estimate: bins are counts, the ramp is normalised to the current
 * selection, and the smoothing radius is chosen for legibility rather than to fit a
 * kernel bandwidth. Every reading is "more here than there, in this selection".
 */

import type { MapTracks } from '../data/model';
import { EventCode } from '../data/types';

export type HeatmapMode = 'none' | 'traffic' | 'kills' | 'deaths';

/** Event codes contributing to each mode, exactly as specified. */
export const HEATMAP_CODES: Record<Exclude<HeatmapMode, 'none'>, ReadonlySet<number>> = {
  traffic: new Set([EventCode.Position, EventCode.BotPosition]),
  kills: new Set([EventCode.Kill, EventCode.BotKill]),
  deaths: new Set([EventCode.Killed, EventCode.BotKilled, EventCode.KilledByStorm]),
};

export const HEATMAP_LABELS: Record<Exclude<HeatmapMode, 'none'>, string> = {
  traffic: 'Traffic',
  kills: 'Kill zones',
  deaths: 'Death zones',
};

/** Grid resolution in bins per axis. 160 keeps bins near a few world units across. */
export const GRID_RESOLUTION = 160;

/** Smoothing radius in bins, per mode. Sparse layers need more to read as a field. */
export const BLUR_RADIUS: Record<Exclude<HeatmapMode, 'none'>, number> = {
  traffic: 2,
  kills: 3,
  deaths: 3,
};

export interface HeatmapGrid {
  resolution: number;
  /** Row-major, `resolution * resolution`. Row 0 is the top of the image. */
  values: Float32Array;
  /** Highest single-bin value after smoothing. */
  max: number;
  /** Events binned. */
  total: number;
  /** Bins with any weight, for the "how concentrated is this" readout. */
  occupied: number;
}

/**
 * Bin visible points into a grid.
 *
 * Deliberately independent of playback time: the heatmap is the standing context a
 * designer reads the playhead against, so it must not flicker or re-aggregate while the
 * clock runs.
 */
export function buildGrid(
  tracks: MapTracks | null,
  visibleSlots: Uint8Array | null,
  mode: HeatmapMode,
  resolution = GRID_RESOLUTION,
): HeatmapGrid {
  const values = new Float32Array(resolution * resolution);
  if (!tracks || mode === 'none') {
    return { resolution, values, max: 0, total: 0, occupied: 0 };
  }

  const codes = HEATMAP_CODES[mode];
  let total = 0;

  for (let i = 0; i < tracks.pointCount; i++) {
    if (!codes.has(tracks.eventType[i] ?? -1)) continue;
    const slot = tracks.journeySlot[i] ?? 0;
    if (visibleSlots && !visibleSlots[slot]) continue;

    const u = tracks.u[i] ?? 0;
    const v = tracks.v[i] ?? 0;
    // Row 0 is the top: v runs upward, image rows run downward.
    const bx = Math.min(resolution - 1, Math.max(0, (u * resolution) | 0));
    const by = Math.min(resolution - 1, Math.max(0, ((1 - v) * resolution) | 0));
    const bin = by * resolution + bx;
    values[bin] = (values[bin] ?? 0) + 1;
    total++;
  }

  let max = 0;
  let occupied = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? 0;
    if (value > 0) occupied++;
    if (value > max) max = value;
  }
  return { resolution, values, max, total, occupied };
}

/**
 * Separable box blur, run twice to approximate a Gaussian.
 *
 * Smoothing is what turns 39 storm deaths from unreadable confetti into a field a
 * designer can point at. It is a legibility choice, not a statistical one.
 */
export function blurGrid(grid: HeatmapGrid, radius: number): HeatmapGrid {
  if (radius <= 0) return grid;
  const { resolution } = grid;
  let source = grid.values;
  const scratch = new Float32Array(source.length);

  for (let pass = 0; pass < 2; pass++) {
    // Horizontal
    for (let y = 0; y < resolution; y++) {
      const row = y * resolution;
      for (let x = 0; x < resolution; x++) {
        let sum = 0;
        let count = 0;
        for (let k = -radius; k <= radius; k++) {
          const nx = x + k;
          if (nx < 0 || nx >= resolution) continue;
          sum += source[row + nx]!;
          count++;
        }
        scratch[row + x] = sum / count;
      }
    }
    // Vertical
    const next = pass === 0 ? new Float32Array(source.length) : source;
    for (let x = 0; x < resolution; x++) {
      for (let y = 0; y < resolution; y++) {
        let sum = 0;
        let count = 0;
        for (let k = -radius; k <= radius; k++) {
          const ny = y + k;
          if (ny < 0 || ny >= resolution) continue;
          sum += scratch[ny * resolution + x]!;
          count++;
        }
        next[y * resolution + x] = sum / count;
      }
    }
    source = next;
  }

  let max = 0;
  let occupied = 0;
  for (let i = 0; i < source.length; i++) {
    const value = source[i]!;
    if (value > 1e-6) occupied++;
    if (value > max) max = value;
  }
  return { resolution, values: source, max, total: grid.total, occupied };
}

/**
 * Upper bound for the colour ramp.
 *
 * Uses a high percentile of occupied bins rather than the raw maximum, so a single
 * extreme hotspot cannot flatten the rest of the map into one colour. The remaining bins
 * above the cap simply saturate.
 */
export function intensityCap(grid: HeatmapGrid, percentile = 0.99): number {
  const occupied: number[] = [];
  for (let i = 0; i < grid.values.length; i++) {
    const value = grid.values[i]!;
    if (value > 1e-6) occupied.push(value);
  }
  if (occupied.length === 0) return 0;
  occupied.sort((a, b) => a - b);
  const index = Math.min(occupied.length - 1, Math.floor(occupied.length * percentile));
  return occupied[index] ?? grid.max;
}

/** Colour stops per mode, so the active layer is identifiable without reading a label. */
export const RAMPS: Record<Exclude<HeatmapMode, 'none'>, [number, number, number][]> = {
  // cool -> hot, staying clear of the red used for death markers
  traffic: [
    [23, 62, 120],
    [32, 126, 176],
    [86, 200, 190],
    [190, 240, 205],
    [255, 255, 235],
  ],
  kills: [
    [92, 40, 8],
    [168, 74, 12],
    [232, 128, 30],
    [255, 190, 92],
    [255, 240, 200],
  ],
  deaths: [
    [90, 12, 30],
    [163, 26, 52],
    [226, 62, 80],
    [255, 130, 130],
    [255, 225, 220],
  ],
};

function sampleRamp(stops: [number, number, number][], t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const a = stops[index]!;
  const b = stops[index + 1]!;
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

/** Peak opacity of the overlay. Kept below 1 so the artwork stays readable underneath. */
export const MAX_ALPHA = 0.78;

/**
 * Render the grid into RGBA bytes.
 *
 * Alpha rises with intensity so empty ground stays fully transparent and the map reads
 * through the layer. The `^0.75` curve lifts low values enough to be visible without
 * letting them dominate.
 */
export function gridToRgba(
  grid: HeatmapGrid,
  mode: Exclude<HeatmapMode, 'none'>,
  cap: number,
  intensity = 1,
): Uint8ClampedArray<ArrayBuffer> {
  // Explicit ArrayBuffer backing: ImageData's typings reject the ArrayBufferLike default.
  const rgba = new Uint8ClampedArray(new ArrayBuffer(grid.values.length * 4));
  if (cap <= 0) return rgba;

  const stops = RAMPS[mode];
  for (let i = 0; i < grid.values.length; i++) {
    const value = grid.values[i]!;
    if (value <= 1e-6) continue;
    const t = Math.min(1, value / cap);
    const [r, g, b] = sampleRamp(stops, t);
    const offset = i * 4;
    rgba[offset] = r;
    rgba[offset + 1] = g;
    rgba[offset + 2] = b;
    rgba[offset + 3] = Math.round(255 * Math.min(1, t ** 0.75 * MAX_ALPHA * intensity));
  }
  return rgba;
}

/** Legend swatches for the active ramp, low to high. */
export function rampSwatches(
  mode: Exclude<HeatmapMode, 'none'>,
  steps = 5,
): { t: number; css: string }[] {
  const stops = RAMPS[mode];
  return Array.from({ length: steps }, (_, i) => {
    const t = steps === 1 ? 1 : i / (steps - 1);
    const [r, g, b] = sampleRamp(stops, t);
    return { t, css: `rgb(${r}, ${g}, ${b})` };
  });
}
