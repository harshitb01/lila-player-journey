/**
 * Time-clipping primitives for match playback.
 *
 * Playback is deterministic by construction: what is drawn at time `t` is a pure
 * function of `t` and the immutable track arrays. Nothing accumulates frame to frame, so
 * seeking backwards, seeking forwards, and playing through all produce byte-identical
 * frames for the same `t`. The clock is the only stateful part, and it only decides
 * *which* `t` to draw.
 *
 * Points within a journey are contiguous in the flat arrays and already sorted by
 * `tRel` (the pipeline sorts by `t_rel` then `event`), so the cutoff is a binary search.
 * No per-frame index needs building.
 */

import type { MapTracks } from '../data/model';

export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export function isPlaybackSpeed(value: number): value is PlaybackSpeed {
  return (PLAYBACK_SPEEDS as readonly number[]).includes(value);
}

/**
 * Index of the last point in `[start, end)` whose `tRel` is <= `t`.
 *
 * Returns `start - 1` when every point is later than `t`, which callers read as "this
 * actor has not appeared yet". Exclusive upper bound, half-open like the offsets array.
 */
export function lastIndexAtOrBefore(
  tRel: Uint16Array,
  start: number,
  end: number,
  t: number,
): number {
  let lo = start;
  let hi = end - 1;
  let result = start - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((tRel[mid] ?? 0) <= t) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/** The slice of one journey that has occurred by time `t`. */
export interface JourneyWindow {
  start: number;
  /** Exclusive end of the elapsed slice. Equals `start` when nothing has happened yet. */
  end: number;
  /** True when at least one point has occurred. */
  hasAny: boolean;
}

export function windowForJourney(
  tracks: MapTracks,
  slot: number,
  t: number | null,
): JourneyWindow {
  const start = tracks.offsets[slot] ?? 0;
  const fullEnd = tracks.offsets[slot + 1] ?? start;
  if (t === null) return { start, end: fullEnd, hasAny: fullEnd > start };

  const last = lastIndexAtOrBefore(tracks.tRel, start, fullEnd, t);
  const end = last + 1;
  return { start, end, hasAny: end > start };
}

/** Clamp a playback position into `[0, duration]`. */
export function clampTime(time: number, duration: number): number {
  // NaN has no position to clamp toward, so it rewinds. Infinities are meaningful
  // ("before the start" / "past the end") and clamp normally.
  if (Number.isNaN(time)) return 0;
  if (duration <= 0) return 0;
  return Math.min(duration, Math.max(0, time));
}

/**
 * Advance the clock by one frame.
 *
 * Separated from the animation loop so the stepping rule is testable without a browser.
 * Elapsed real time is scaled by `speed`, so changing speed affects only what happens
 * next and never rewrites where playback already is.
 */
export function advance(
  time: number,
  deltaSeconds: number,
  speed: number,
  duration: number,
): { time: number; ended: boolean } {
  if (duration <= 0) return { time: 0, ended: true };
  const next = time + deltaSeconds * speed;
  if (next >= duration) return { time: duration, ended: true };
  return { time: Math.max(0, next), ended: false };
}
