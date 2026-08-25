/**
 * Region selection: drag-select a rectangle on the map, get real counts back.
 *
 * The heatmap answers "where is it hot"; this answers "how hot, exactly, and how does
 * that compare to the rest of the map". Both read the same underlying track arrays —
 * this module just sums inside a rectangle instead of painting a gradient.
 *
 * Deliberately independent of playback time, for the same reason the heatmap is: this
 * is standing context a designer reads the playhead against, not a live overlay that
 * should flicker as the clock runs. See heatmap.ts.
 */

import type { MapTracks } from '../data/model';
import { EventCode, MOVEMENT_CODES } from '../data/types';
import type { Rect } from './viewport';
import { canvasToUv } from './viewport';

/** A rectangle in normalised map space, corners not assumed ordered. */
export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Smallest drag, in CSS pixels, treated as an intentional region rather than a slip. */
export const MIN_DRAG_PX = 6;

/**
 * Build a UV rectangle from two canvas points, or null if the drag was too small to be
 * deliberate (a stray Shift+click, not a marquee).
 */
export function regionFromCanvasDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
  rect: Rect,
): UvRect | null {
  if (Math.hypot(end.x - start.x, end.y - start.y) < MIN_DRAG_PX) return null;

  const a = canvasToUv(start, rect);
  const b = canvasToUv(end, rect);
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

  return {
    u0: clamp01(Math.min(a.u, b.u)),
    v0: clamp01(Math.min(a.v, b.v)),
    u1: clamp01(Math.max(a.u, b.u)),
    v1: clamp01(Math.max(a.v, b.v)),
  };
}

function containsUv(region: UvRect, u: number, v: number): boolean {
  return u >= region.u0 && u <= region.u1 && v >= region.v0 && v <= region.v1;
}

/** The four categories the assignment names, each mapped to its exact event set. */
export type RegionCategory = 'traffic' | 'kills' | 'deaths' | 'storm';

const CATEGORY_CODES: Record<RegionCategory, ReadonlySet<number>> = {
  traffic: MOVEMENT_CODES,
  kills: new Set([EventCode.Kill, EventCode.BotKill]),
  deaths: new Set([EventCode.Killed, EventCode.BotKilled]),
  storm: new Set([EventCode.KilledByStorm]),
};

export interface RegionStats {
  /** Telemetry rows of any kind inside the rectangle. */
  totalPoints: number;
  counts: Record<RegionCategory, number>;
  /** Distinct journeys with at least one point inside the rectangle. */
  journeys: number;
  humans: number;
  bots: number;
}

function emptyStats(): RegionStats {
  return {
    totalPoints: 0,
    counts: { traffic: 0, kills: 0, deaths: 0, storm: 0 },
    journeys: 0,
    humans: 0,
    bots: 0,
  };
}

/**
 * Count telemetry inside a UV rectangle.
 *
 * Linear over the map's points, same cost class as `buildGrid` and `pickJourney`, and
 * only runs when the region or the filtered selection changes — never per animation
 * frame.
 */
export function computeRegionStats(
  tracks: MapTracks | null,
  visibleSlots: Uint8Array | null,
  slotIsBot: Uint8Array | null,
  region: UvRect | null,
): RegionStats {
  if (!tracks || !region) return emptyStats();

  const stats = emptyStats();
  const journeySlots = new Set<number>();

  for (let i = 0; i < tracks.pointCount; i++) {
    const slot = tracks.journeySlot[i] ?? 0;
    if (visibleSlots && !visibleSlots[slot]) continue;

    const u = tracks.u[i] ?? 0;
    const v = tracks.v[i] ?? 0;
    if (!containsUv(region, u, v)) continue;

    stats.totalPoints++;
    journeySlots.add(slot);

    const code = tracks.eventType[i] ?? -1;
    for (const category of Object.keys(CATEGORY_CODES) as RegionCategory[]) {
      if (CATEGORY_CODES[category].has(code)) stats.counts[category]++;
    }
  }

  for (const slot of journeySlots) {
    if (slotIsBot?.[slot] === 1) stats.bots++;
    else stats.humans++;
  }
  stats.journeys = journeySlots.size;

  return stats;
}

/** World-space size of a region, given the map's projection scale. */
export function regionWorldSize(region: UvRect, scale: number): { width: number; depth: number } {
  return {
    width: (region.u1 - region.u0) * scale,
    depth: (region.v1 - region.v0) * scale,
  };
}
