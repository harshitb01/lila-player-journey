import { describe, expect, it } from 'vitest';

import type { MapTracks } from '../data/model';
import { EventCode } from '../data/types';
import {
  MIN_DRAG_PX,
  computeRegionStats,
  regionFromCanvasDrag,
  regionWorldSize,
  type UvRect,
} from './region';
import type { Rect } from './viewport';

interface Pt {
  u: number;
  v: number;
  e: number;
  slot?: number;
}

function makeTracks(points: Pt[], journeyCount = 1): MapTracks {
  const n = points.length;
  const offsets = new Uint32Array(journeyCount + 1);
  offsets[journeyCount] = n;
  return {
    mapId: 'AmbroseValley',
    journeyCount,
    pointCount: n,
    journeyIds: Int32Array.from(Array.from({ length: journeyCount }, (_, i) => i)),
    offsets,
    worldX: new Float32Array(n),
    worldZ: new Float32Array(n),
    u: Float32Array.from(points.map((p) => p.u)),
    v: Float32Array.from(points.map((p) => p.v)),
    tRel: new Uint16Array(n),
    eventType: Uint8Array.from(points.map((p) => p.e)),
    journeySlot: Uint32Array.from(points.map((p) => p.slot ?? 0)),
  };
}

const RECT: Rect = { x: 100, y: 50, width: 800, height: 400 };

describe('regionFromCanvasDrag', () => {
  it('normalises corners regardless of drag direction', () => {
    const dragged = regionFromCanvasDrag({ x: 500, y: 250 }, { x: 300, y: 150 }, RECT)!;
    expect(dragged.u0).toBeLessThan(dragged.u1);
    expect(dragged.v0).toBeLessThan(dragged.v1);
  });

  it('rejects a drag shorter than the minimum, treating it as a stray click', () => {
    expect(regionFromCanvasDrag({ x: 400, y: 200 }, { x: 400, y: 200 }, RECT)).toBeNull();
    expect(
      regionFromCanvasDrag(
        { x: 400, y: 200 },
        { x: 400 + MIN_DRAG_PX - 1, y: 200 },
        RECT,
      ),
    ).toBeNull();
  });

  it('accepts a drag at or above the minimum', () => {
    expect(
      regionFromCanvasDrag({ x: 400, y: 200 }, { x: 400 + MIN_DRAG_PX + 1, y: 200 }, RECT),
    ).not.toBeNull();
  });

  it('clamps to the map even when the drag runs outside the fitted rect', () => {
    const region = regionFromCanvasDrag({ x: -500, y: -500 }, { x: 5000, y: 5000 }, RECT)!;
    expect(region).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 });
  });
});

describe('computeRegionStats', () => {
  const POS = EventCode.Position;
  const region: UvRect = { u0: 0.2, v0: 0.2, u1: 0.5, v1: 0.5 };

  it('returns zeroed stats for a null region or null tracks', () => {
    const empty = computeRegionStats(null, null, null, region);
    expect(empty.totalPoints).toBe(0);
    expect(computeRegionStats(makeTracks([{ u: 0.3, v: 0.3, e: POS }]), null, null, null).totalPoints).toBe(0);
  });

  it('counts only points inside the rectangle', () => {
    const tracks = makeTracks([
      { u: 0.3, v: 0.3, e: POS }, // inside
      { u: 0.9, v: 0.9, e: POS }, // outside
    ]);
    const stats = computeRegionStats(tracks, null, null, region);
    expect(stats.totalPoints).toBe(1);
  });

  it('treats the rectangle as inclusive of its boundary', () => {
    const tracks = makeTracks([
      { u: 0.2, v: 0.2, e: POS }, // exactly on the low corner
      { u: 0.5, v: 0.5, e: POS }, // exactly on the high corner
    ]);
    expect(computeRegionStats(tracks, null, null, region).totalPoints).toBe(2);
  });

  it('buckets events into exactly the four specified categories', () => {
    const tracks = makeTracks([
      { u: 0.3, v: 0.3, e: EventCode.Position },
      { u: 0.3, v: 0.3, e: EventCode.BotPosition },
      { u: 0.3, v: 0.3, e: EventCode.Kill },
      { u: 0.3, v: 0.3, e: EventCode.BotKill },
      { u: 0.3, v: 0.3, e: EventCode.Killed },
      { u: 0.3, v: 0.3, e: EventCode.BotKilled },
      { u: 0.3, v: 0.3, e: EventCode.KilledByStorm },
      { u: 0.3, v: 0.3, e: EventCode.Loot }, // not one of the four — must not appear anywhere
    ]);
    const stats = computeRegionStats(tracks, null, null, region);
    expect(stats.counts).toEqual({ traffic: 2, kills: 2, deaths: 2, storm: 1 });
    expect(stats.totalPoints).toBe(8); // loot still counts toward the raw total
  });

  it('respects visibleSlots the same way every other layer does', () => {
    const tracks = makeTracks(
      [
        { u: 0.3, v: 0.3, e: POS, slot: 0 },
        { u: 0.3, v: 0.3, e: POS, slot: 1 },
      ],
      2,
    );
    const onlyFirst = computeRegionStats(tracks, Uint8Array.from([1, 0]), null, region);
    expect(onlyFirst.totalPoints).toBe(1);
  });

  it('counts distinct journeys, not points, and splits human/bot', () => {
    const tracks = makeTracks(
      [
        { u: 0.3, v: 0.3, e: POS, slot: 0 },
        { u: 0.31, v: 0.31, e: EventCode.Loot, slot: 0 }, // same journey, second point
        { u: 0.4, v: 0.4, e: EventCode.BotPosition, slot: 1 },
      ],
      2,
    );
    const slotIsBot = Uint8Array.from([0, 1]);
    const stats = computeRegionStats(tracks, null, slotIsBot, region);
    expect(stats.journeys).toBe(2);
    expect(stats.humans).toBe(1);
    expect(stats.bots).toBe(1);
  });

  it('is independent of any notion of time — no playback parameter exists', () => {
    // Structural guarantee: the function has no time argument to accidentally wire up,
    // so it cannot flicker under the playhead.
    expect(computeRegionStats.length).toBe(4);
  });
});

describe('regionWorldSize', () => {
  it('scales the UV extent by the map projection scale', () => {
    const region: UvRect = { u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.5 };
    const size = regionWorldSize(region, 900);
    expect(size.width).toBeCloseTo(0.2 * 900, 6);
    expect(size.depth).toBeCloseTo(0.3 * 900, 6);
  });
});
