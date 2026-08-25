import { describe, expect, it } from 'vitest';

import type { MapTracks } from '../data/model';
import { EventCode } from '../data/types';
import { estimateTravel, formatDuration, summarise } from './journeyStats';

/** Builds a single-journey MapTracks fixture from explicit points. */
function makeTracks(points: { x: number; z: number; t: number; e: number }[]): MapTracks {
  const n = points.length;
  return {
    mapId: 'AmbroseValley',
    journeyCount: 1,
    pointCount: n,
    journeyIds: Int32Array.from([0]),
    offsets: Uint32Array.from([0, n]),
    worldX: Float32Array.from(points.map((p) => p.x)),
    worldZ: Float32Array.from(points.map((p) => p.z)),
    u: new Float32Array(n),
    v: new Float32Array(n),
    tRel: Uint16Array.from(points.map((p) => p.t)),
    eventType: Uint8Array.from(points.map((p) => p.e)),
    journeySlot: new Uint32Array(n),
  };
}

const P = EventCode.Position;

describe('estimateTravel', () => {
  it('sums straight-line ground distance between consecutive samples', () => {
    const tracks = makeTracks([
      { x: 0, z: 0, t: 0, e: P },
      { x: 3, z: 4, t: 5, e: P }, // 5 units
      { x: 3, z: 14, t: 10, e: P }, // 10 units
    ]);
    const result = estimateTravel(tracks, 0);
    expect(result.distanceWorldUnits).toBeCloseTo(15, 10);
    expect(result.segments).toBe(2);
    expect(result.sampleCount).toBe(3);
    expect(result.insufficientData).toBe(false);
  });

  it('ignores elevation — distance is measured on the ground plane', () => {
    // y is not part of MapTracks at all, so a vertical move registers as zero distance.
    const tracks = makeTracks([
      { x: 0, z: 0, t: 0, e: P },
      { x: 0, z: 0, t: 5, e: P },
    ]);
    expect(estimateTravel(tracks, 0).distanceWorldUnits).toBe(0);
  });

  it('excludes segments spanning a long gap rather than bridging them', () => {
    const tracks = makeTracks([
      { x: 0, z: 0, t: 0, e: P },
      { x: 3, z: 4, t: 5, e: P }, // 5 units, kept
      { x: 300, z: 4, t: 400, e: P }, // 395 s gap — excluded
      { x: 306, z: 12, t: 405, e: P }, // 10 units, kept
    ]);
    const result = estimateTravel(tracks, 0);
    expect(result.distanceWorldUnits).toBeCloseTo(15, 10);
    expect(result.segments).toBe(2);
    expect(result.gapsExcluded).toBe(1);
    expect(result.longestGapSec).toBe(395);
  });

  it('counts only movement samples, not discrete events', () => {
    const tracks = makeTracks([
      { x: 0, z: 0, t: 0, e: P },
      { x: 0, z: 0, t: 2, e: EventCode.Loot },
      { x: 3, z: 4, t: 5, e: P },
    ]);
    const result = estimateTravel(tracks, 0);
    expect(result.sampleCount).toBe(2);
    expect(result.segments).toBe(1);
    expect(result.distanceWorldUnits).toBeCloseTo(5, 10);
  });

  it('flags a single-sample journey as insufficient rather than reporting zero travel', () => {
    const tracks = makeTracks([{ x: 10, z: 10, t: 0, e: P }]);
    const result = estimateTravel(tracks, 0);
    expect(result.insufficientData).toBe(true);
    expect(result.sampleCount).toBe(1);
    expect(result.segments).toBe(0);
  });

  it('handles a journey with no movement samples at all', () => {
    const tracks = makeTracks([{ x: 0, z: 0, t: 0, e: EventCode.Loot }]);
    const result = estimateTravel(tracks, 0);
    expect(result.insufficientData).toBe(true);
    expect(result.sampleCount).toBe(0);
    expect(result.distanceWorldUnits).toBe(0);
  });

  it('is a lower bound: a curved route reads shorter than the path actually walked', () => {
    // Two samples 10 units apart in a straight line vs. the same endpoints sampled
    // mid-route. Denser sampling can only ever recover more of the true distance.
    const sparse = makeTracks([
      { x: 0, z: 0, t: 0, e: P },
      { x: 10, z: 0, t: 5, e: P },
    ]);
    const dense = makeTracks([
      { x: 0, z: 0, t: 0, e: P },
      { x: 5, z: 5, t: 2, e: P },
      { x: 10, z: 0, t: 5, e: P },
    ]);
    expect(estimateTravel(dense, 0).distanceWorldUnits).toBeGreaterThan(
      estimateTravel(sparse, 0).distanceWorldUnits,
    );
  });
});

describe('summarise', () => {
  const base = {
    id: 0,
    userId: 'u',
    match: 0,
    mapId: 'AmbroseValley' as const,
    date: '2026-02-10',
    sourceFolder: 'February_10',
    actorType: 'human' as const,
    idFormat: 'uuid' as const,
    actorIdConflict: false,
    startTRel: 0,
    durationSec: 372,
    sampleCount: 59,
  };

  it('groups kills and deaths across their event variants', () => {
    const summary = summarise({
      ...base,
      eventCounts: {
        Kill: 1,
        BotKill: 4,
        Killed: 0,
        BotKilled: 1,
        KilledByStorm: 1,
        Loot: 14,
        Position: 59,
        BotPosition: 0,
      },
    });
    expect(summary.kills).toBe(5);
    expect(summary.deaths).toBe(2);
    expect(summary.stormDeaths).toBe(1);
    expect(summary.loot).toBe(14);
    expect(summary.observedDurationSec).toBe(372);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [59, '0:59'],
    [60, '1:00'],
    [372, '6:12'],
    [890, '14:50'],
  ])('formats %i seconds as %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });

  it('clamps negatives rather than emitting a malformed string', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });
});
