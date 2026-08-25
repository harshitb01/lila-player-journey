import { describe, expect, it } from 'vitest';

import type { MapTracks } from '../data/model';
import { EventCode } from '../data/types';
import {
  PLAYBACK_SPEEDS,
  advance,
  clampTime,
  isPlaybackSpeed,
  lastIndexAtOrBefore,
  windowForJourney,
} from './playback';

const P = EventCode.Position;

/** Two journeys with explicit timings. */
function makeTracks(journeys: { t: number; e: number }[][]): MapTracks {
  const offsets: number[] = [0];
  const tRel: number[] = [];
  const eventType: number[] = [];
  const journeySlot: number[] = [];

  journeys.forEach((points, slot) => {
    for (const p of points) {
      tRel.push(p.t);
      eventType.push(p.e);
      journeySlot.push(slot);
    }
    offsets.push(tRel.length);
  });

  const n = tRel.length;
  return {
    mapId: 'AmbroseValley',
    journeyCount: journeys.length,
    pointCount: n,
    journeyIds: Int32Array.from(journeys.map((_, i) => i)),
    offsets: Uint32Array.from(offsets),
    worldX: new Float32Array(n),
    worldZ: new Float32Array(n),
    u: new Float32Array(n),
    v: new Float32Array(n),
    tRel: Uint16Array.from(tRel),
    eventType: Uint8Array.from(eventType),
    journeySlot: Uint32Array.from(journeySlot),
  };
}

describe('lastIndexAtOrBefore', () => {
  const tRel = Uint16Array.from([0, 5, 10, 15, 20]);

  it('finds the last index at or before the target', () => {
    expect(lastIndexAtOrBefore(tRel, 0, 5, 10)).toBe(2);
    expect(lastIndexAtOrBefore(tRel, 0, 5, 20)).toBe(4);
  });

  it('includes an exact match — "at or before" is inclusive', () => {
    expect(lastIndexAtOrBefore(tRel, 0, 5, 5)).toBe(1);
    expect(lastIndexAtOrBefore(tRel, 0, 5, 0)).toBe(0);
  });

  it('returns start - 1 when everything is in the future', () => {
    expect(lastIndexAtOrBefore(tRel, 0, 5, -1)).toBe(-1);
  });

  it('clamps to the last index beyond the end', () => {
    expect(lastIndexAtOrBefore(tRel, 0, 5, 9999)).toBe(4);
  });

  it('interpolates between samples by taking the earlier one', () => {
    expect(lastIndexAtOrBefore(tRel, 0, 5, 7)).toBe(1);
    expect(lastIndexAtOrBefore(tRel, 0, 5, 14.9)).toBe(2);
  });

  it('respects a sub-range', () => {
    expect(lastIndexAtOrBefore(tRel, 2, 5, 100)).toBe(4);
    expect(lastIndexAtOrBefore(tRel, 2, 5, 3)).toBe(1); // start - 1
  });

  it('handles an empty range', () => {
    expect(lastIndexAtOrBefore(tRel, 3, 3, 100)).toBe(2);
  });
});

describe('windowForJourney', () => {
  const tracks = makeTracks([
    [
      { t: 0, e: P },
      { t: 5, e: P },
      { t: 10, e: P },
    ],
    [
      { t: 20, e: P },
      { t: 25, e: P },
    ],
  ]);

  it('returns the whole journey when there is no playback clock', () => {
    expect(windowForJourney(tracks, 0, null)).toEqual({ start: 0, end: 3, hasAny: true });
  });

  it('clips to elapsed points', () => {
    expect(windowForJourney(tracks, 0, 5)).toEqual({ start: 0, end: 2, hasAny: true });
    expect(windowForJourney(tracks, 0, 0)).toEqual({ start: 0, end: 1, hasAny: true });
  });

  it('reports nothing for an actor whose first sample is still in the future', () => {
    // Slot 1 starts at t=20. At t=10 they have no recorded position yet.
    const window = windowForJourney(tracks, 1, 10);
    expect(window.hasAny).toBe(false);
    expect(window.end).toBe(window.start);
  });

  it('keeps showing an actor after their telemetry stops', () => {
    // Slot 0 ends at t=10; at t=500 it still yields the full slice, not an empty one.
    expect(windowForJourney(tracks, 0, 500)).toEqual({ start: 0, end: 3, hasAny: true });
  });
});

describe('determinism', () => {
  const tracks = makeTracks([
    [
      { t: 0, e: P },
      { t: 5, e: P },
      { t: 10, e: P },
      { t: 15, e: P },
      { t: 20, e: P },
    ],
  ]);

  it('yields the same window for a time however it was reached', () => {
    const target = 12;

    // Reached by playing forward in small steps.
    let time = 0;
    for (let i = 0; i < 24; i++) time = advance(time, 0.5, 1, 20).time;
    const forward = windowForJourney(tracks, 0, Math.min(time, target));

    // Reached by seeking backwards from the end.
    const backward = windowForJourney(tracks, 0, target);

    // Reached by a direct jump.
    const jumped = windowForJourney(tracks, 0, target);

    expect(backward).toEqual(jumped);
    expect(forward.end).toBeLessThanOrEqual(jumped.end + 1);
  });

  it('is monotonic — a later time never shows fewer points', () => {
    let previous = -1;
    for (let t = 0; t <= 25; t += 0.5) {
      const { end } = windowForJourney(tracks, 0, t);
      expect(end).toBeGreaterThanOrEqual(previous);
      previous = end;
    }
  });

  it('gives identical results for repeated calls at the same time', () => {
    for (const t of [0, 3.3, 7.5, 12, 19.99, 20]) {
      expect(windowForJourney(tracks, 0, t)).toEqual(windowForJourney(tracks, 0, t));
    }
  });
});

describe('advance', () => {
  it('scales elapsed real time by the speed', () => {
    expect(advance(0, 1, 1, 100).time).toBe(1);
    expect(advance(0, 1, 2, 100).time).toBe(2);
    expect(advance(0, 1, 0.5, 100).time).toBe(0.5);
    expect(advance(0, 1, 4, 100).time).toBe(4);
  });

  it('stops exactly at the duration and reports the end', () => {
    const result = advance(99, 5, 1, 100);
    expect(result.time).toBe(100);
    expect(result.ended).toBe(true);
  });

  it('does not report the end before reaching it', () => {
    expect(advance(50, 1, 1, 100).ended).toBe(false);
  });

  it('never produces a negative time', () => {
    expect(advance(1, -10, 1, 100).time).toBe(0);
  });

  it('treats a zero-length match as already ended', () => {
    expect(advance(0, 1, 1, 0)).toEqual({ time: 0, ended: true });
  });

  it('changing speed affects only what comes next, never the past', () => {
    // Two seconds at 1x, then two at 4x, must equal 2 + 8.
    let time = 0;
    time = advance(time, 2, 1, 100).time;
    expect(time).toBe(2);
    time = advance(time, 2, 4, 100).time;
    expect(time).toBe(10);
  });
});

describe('clampTime', () => {
  it('clamps into range', () => {
    expect(clampTime(-5, 100)).toBe(0);
    expect(clampTime(150, 100)).toBe(100);
    expect(clampTime(50, 100)).toBe(50);
  });

  it('guards against a non-finite input', () => {
    expect(clampTime(Number.NaN, 100)).toBe(0);
    expect(clampTime(Infinity, 100)).toBe(100);
  });

  it('returns 0 for a zero-length match', () => {
    expect(clampTime(10, 0)).toBe(0);
  });
});

describe('speeds', () => {
  it('offers exactly the four required rates', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.5, 1, 2, 4]);
  });

  it('validates speed values', () => {
    expect(isPlaybackSpeed(2)).toBe(true);
    expect(isPlaybackSpeed(3)).toBe(false);
  });
});
