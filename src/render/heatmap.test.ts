import { describe, expect, it } from 'vitest';

import type { MapTracks } from '../data/model';
import { EventCode } from '../data/types';
import { MAP_CONFIGS, worldToUv } from '../utils/coordinates';
import { uvToCanvas } from './viewport';
import {
  GRID_RESOLUTION,
  HEATMAP_CODES,
  MAX_ALPHA,
  blurGrid,
  buildGrid,
  gridToRgba,
  intensityCap,
  rampSwatches,
} from './heatmap';

interface Pt {
  u: number;
  v: number;
  e: number;
  slot?: number;
}

function makeTracks(points: Pt[], journeyCount = 1): MapTracks {
  const n = points.length;
  const offsets = new Uint32Array(journeyCount + 1);
  for (let i = 0; i <= journeyCount; i++) offsets[i] = i === journeyCount ? n : 0;
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

const POS = EventCode.Position;
const BOTPOS = EventCode.BotPosition;

describe('mode definitions', () => {
  it('matches the specified event sets exactly', () => {
    expect([...HEATMAP_CODES.traffic].sort()).toEqual(
      [EventCode.Position, EventCode.BotPosition].sort(),
    );
    expect([...HEATMAP_CODES.kills].sort()).toEqual(
      [EventCode.Kill, EventCode.BotKill].sort(),
    );
    expect([...HEATMAP_CODES.deaths].sort()).toEqual(
      [EventCode.Killed, EventCode.BotKilled, EventCode.KilledByStorm].sort(),
    );
  });

  it('counts both human and bot movement as traffic', () => {
    const tracks = makeTracks([
      { u: 0.5, v: 0.5, e: POS },
      { u: 0.5, v: 0.5, e: BOTPOS },
    ]);
    expect(buildGrid(tracks, null, 'traffic').total).toBe(2);
  });

  it('excludes movement from the kill and death layers', () => {
    const tracks = makeTracks([
      { u: 0.5, v: 0.5, e: POS },
      { u: 0.5, v: 0.5, e: EventCode.BotKill },
      { u: 0.5, v: 0.5, e: EventCode.KilledByStorm },
    ]);
    expect(buildGrid(tracks, null, 'kills').total).toBe(1);
    expect(buildGrid(tracks, null, 'deaths').total).toBe(1);
  });
});

describe('binning and alignment', () => {
  it('places a point in the bin its UV selects', () => {
    const grid = buildGrid(makeTracks([{ u: 0.25, v: 0.75, e: POS }]), null, 'traffic', 4);
    // u=0.25 -> column 1; v=0.75 -> row (1-0.75)*4 = 1
    expect(grid.values[1 * 4 + 1]).toBe(1);
    expect(grid.total).toBe(1);
    expect(grid.occupied).toBe(1);
  });

  it('flips v so grid row 0 is the top of the image', () => {
    // v = 1 is the top of the map, which must land in row 0.
    const top = buildGrid(makeTracks([{ u: 0.5, v: 0.999, e: POS }]), null, 'traffic', 4);
    expect(top.values[0 * 4 + 2]).toBe(1);

    const bottom = buildGrid(makeTracks([{ u: 0.5, v: 0.001, e: POS }]), null, 'traffic', 4);
    expect(bottom.values[3 * 4 + 2]).toBe(1);
  });

  it('clamps the boundaries into range rather than overflowing', () => {
    const grid = buildGrid(
      makeTracks([
        { u: 1, v: 1, e: POS },
        { u: 0, v: 0, e: POS },
      ]),
      null,
      'traffic',
      4,
    );
    expect(grid.total).toBe(2);
    expect(grid.values.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('accumulates repeated points in the same bin', () => {
    const grid = buildGrid(
      makeTracks(Array.from({ length: 7 }, () => ({ u: 0.5, v: 0.5, e: POS }))),
      null,
      'traffic',
      4,
    );
    expect(grid.max).toBe(7);
    expect(grid.occupied).toBe(1);
  });
});

describe('filter responsiveness', () => {
  it('honours visibleSlots', () => {
    const tracks = makeTracks(
      [
        { u: 0.2, v: 0.2, e: POS, slot: 0 },
        { u: 0.8, v: 0.8, e: POS, slot: 1 },
      ],
      2,
    );
    const all = buildGrid(tracks, null, 'traffic', 8);
    expect(all.total).toBe(2);

    const onlyFirst = buildGrid(tracks, Uint8Array.from([1, 0]), 'traffic', 8);
    expect(onlyFirst.total).toBe(1);

    const none = buildGrid(tracks, Uint8Array.from([0, 0]), 'traffic', 8);
    expect(none.total).toBe(0);
    expect(none.max).toBe(0);
  });

  it('returns an empty grid for mode "none" without scanning', () => {
    const grid = buildGrid(makeTracks([{ u: 0.5, v: 0.5, e: POS }]), null, 'none');
    expect(grid.total).toBe(0);
    expect(grid.resolution).toBe(GRID_RESOLUTION);
  });

  it('handles null tracks', () => {
    expect(buildGrid(null, null, 'traffic').total).toBe(0);
  });
});

describe('blurGrid', () => {
  it('spreads a single spike into its neighbourhood', () => {
    const grid = buildGrid(makeTracks([{ u: 0.5, v: 0.5, e: POS }]), null, 'traffic', 16);
    const blurred = blurGrid(grid, 2);
    expect(blurred.occupied).toBeGreaterThan(grid.occupied);
    expect(blurred.max).toBeLessThan(grid.max);
  });

  it('conserves roughly the total weight', () => {
    const grid = buildGrid(
      makeTracks(Array.from({ length: 20 }, (_, i) => ({ u: 0.3 + i * 0.01, v: 0.5, e: POS }))),
      null,
      'traffic',
      32,
    );
    const before = grid.values.reduce((a, b) => a + b, 0);
    const after = blurGrid(grid, 2).values.reduce((a, b) => a + b, 0);
    // Edge clamping loses a little; it must not gain or collapse.
    expect(after).toBeGreaterThan(before * 0.8);
    expect(after).toBeLessThanOrEqual(before * 1.05);
  });

  it('is a no-op at radius 0', () => {
    const grid = buildGrid(makeTracks([{ u: 0.5, v: 0.5, e: POS }]), null, 'traffic', 8);
    expect(blurGrid(grid, 0)).toBe(grid);
  });
});

describe('intensityCap', () => {
  it('ignores empty bins so the ramp is not dragged to zero', () => {
    const grid = buildGrid(
      makeTracks([
        { u: 0.1, v: 0.1, e: POS },
        { u: 0.9, v: 0.9, e: POS },
      ]),
      null,
      'traffic',
      64,
    );
    // Thousands of empty bins, two occupied; the cap must reflect the occupied ones.
    expect(intensityCap(grid)).toBe(1);
  });

  it('caps below the max when one hotspot dominates a well-populated map', () => {
    // Spread across many distinct bins, so a percentile is meaningful, then add one
    // extreme outlier. Without the cap, that outlier would flatten everything else.
    const points: Pt[] = [];
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 20; col++) {
        points.push({ u: 0.02 + col * 0.045, v: 0.02 + row * 0.045, e: POS });
      }
    }
    for (let i = 0; i < 500; i++) points.push({ u: 0.5, v: 0.98, e: POS });

    const grid = buildGrid(makeTracks(points), null, 'traffic', 64);
    expect(grid.max).toBeGreaterThanOrEqual(500);
    expect(grid.occupied).toBeGreaterThan(100);

    const cap = intensityCap(grid, 0.9);
    expect(cap).toBeLessThan(grid.max);
    expect(cap).toBeGreaterThan(0);
  });

  it('returns the max when too few bins are occupied for a percentile to mean anything', () => {
    const grid = buildGrid(
      makeTracks([
        { u: 0.1, v: 0.1, e: POS },
        { u: 0.9, v: 0.9, e: POS },
      ]),
      null,
      'traffic',
      64,
    );
    expect(intensityCap(grid, 0.9)).toBe(grid.max);
  });

  it('returns 0 for an empty grid', () => {
    expect(intensityCap(buildGrid(null, null, 'traffic'))).toBe(0);
  });
});

describe('gridToRgba', () => {
  it('leaves empty bins fully transparent so the map reads through', () => {
    const grid = buildGrid(makeTracks([{ u: 0.5, v: 0.5, e: POS }]), null, 'traffic', 4);
    const rgba = gridToRgba(grid, 'traffic', 1);
    let transparent = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 0) transparent++;
    expect(transparent).toBe(15); // 16 bins, 1 occupied
  });

  it('never reaches full opacity, keeping the artwork visible', () => {
    const grid = buildGrid(
      makeTracks(Array.from({ length: 99 }, () => ({ u: 0.5, v: 0.5, e: POS }))),
      null,
      'traffic',
      4,
    );
    const rgba = gridToRgba(grid, 'traffic', 99, 1);
    let maxAlpha = 0;
    for (let i = 3; i < rgba.length; i += 4) maxAlpha = Math.max(maxAlpha, rgba[i]!);
    expect(maxAlpha).toBeLessThanOrEqual(Math.round(255 * MAX_ALPHA));
    expect(maxAlpha).toBeGreaterThan(0);
  });

  it('scales opacity with the intensity control', () => {
    const grid = buildGrid(makeTracks([{ u: 0.5, v: 0.5, e: POS }]), null, 'traffic', 4);
    const alphaAt = (intensity: number) => {
      const rgba = gridToRgba(grid, 'traffic', 1, intensity);
      let max = 0;
      for (let i = 3; i < rgba.length; i += 4) max = Math.max(max, rgba[i]!);
      return max;
    };
    expect(alphaAt(0.5)).toBeLessThan(alphaAt(1));
    expect(alphaAt(1)).toBeLessThanOrEqual(alphaAt(2));
  });

  it('returns a blank buffer when there is nothing to draw', () => {
    const rgba = gridToRgba(buildGrid(null, null, 'traffic'), 'traffic', 0);
    expect(rgba.every((v) => v === 0)).toBe(true);
  });

  it('gives each mode a visually distinct ramp', () => {
    const at = (mode: 'traffic' | 'kills' | 'deaths') => rampSwatches(mode, 3)[2]!.css;
    expect(new Set([at('traffic'), at('kills'), at('deaths')]).size).toBe(3);
  });
});

describe('minimap alignment', () => {
  /**
   * The alignment contract: a point's grid bin must cover the same place on the fitted
   * rect that `uvToCanvas` puts the point itself. The heatmap image is drawn into that
   * rect edge to edge, so bin (col,row) occupies
   *   x in [rect.x + col/res * w, rect.x + (col+1)/res * w]
   *   y in [rect.y + row/res * h, rect.y + (row+1)/res * h]
   * and the point must fall inside its own bin's box.
   */
  const RECT = { x: 220, y: 16, width: 580, height: 580 };
  const RES = 160;

  const samples: [number, number][] = [
    [0.05, 0.103], // AmbroseValley observed minimum
    [0.7464, 0.9264], // observed maximum
    [0.0762, 0.1305], // the dataset README's worked example
    [0.5, 0.5],
    [0.001, 0.999],
    [0.999, 0.001],
  ];

  it('places every point inside the canvas box of its own bin', () => {
    for (const [u, v] of samples) {
      const grid = buildGrid(makeTracks([{ u, v, e: POS }]), null, 'traffic', RES);

      let bin = -1;
      for (let i = 0; i < grid.values.length; i++) if ((grid.values[i] ?? 0) > 0) bin = i;
      expect(bin).toBeGreaterThanOrEqual(0);

      const col = bin % RES;
      const row = Math.floor(bin / RES);

      // Where the renderer draws the point.
      const point = uvToCanvas({ u, v }, RECT);
      // Where the heatmap image places that bin.
      const boxX0 = RECT.x + (col / RES) * RECT.width;
      const boxX1 = RECT.x + ((col + 1) / RES) * RECT.width;
      const boxY0 = RECT.y + (row / RES) * RECT.height;
      const boxY1 = RECT.y + ((row + 1) / RES) * RECT.height;

      expect(point.x).toBeGreaterThanOrEqual(boxX0 - 1e-6);
      expect(point.x).toBeLessThanOrEqual(boxX1 + 1e-6);
      expect(point.y).toBeGreaterThanOrEqual(boxY0 - 1e-6);
      expect(point.y).toBeLessThanOrEqual(boxY1 + 1e-6);
    }
  });

  it('keeps bins within one bin-width of the point at any container size', () => {
    for (const rect of [
      { x: 0, y: 0, width: 400, height: 400 },
      { x: 220, y: 16, width: 580, height: 580 },
      { x: 12, y: 40, width: 1200, height: 1200 },
    ]) {
      const binWidth = rect.width / RES;
      for (const [u, v] of samples) {
        const grid = buildGrid(makeTracks([{ u, v, e: POS }]), null, 'traffic', RES);
        let bin = -1;
        for (let i = 0; i < grid.values.length; i++) if ((grid.values[i] ?? 0) > 0) bin = i;
        const col = bin % RES;
        const point = uvToCanvas({ u, v }, rect);
        const binCentreX = rect.x + ((col + 0.5) / RES) * rect.width;
        expect(Math.abs(point.x - binCentreX)).toBeLessThanOrEqual(binWidth / 2 + 1e-6);
      }
    }
  });

  it('agrees with the projection end to end, from world coordinates', () => {
    // README worked example: AmbroseValley x=-301.45, z=-355.55 -> u 0.0762, v 0.1305
    const config = MAP_CONFIGS.AmbroseValley;
    const uv = worldToUv(-301.45, -355.55, config);
    const grid = buildGrid(makeTracks([{ u: uv.u, v: uv.v, e: POS }]), null, 'traffic', RES);
    let bin = -1;
    for (let i = 0; i < grid.values.length; i++) if ((grid.values[i] ?? 0) > 0) bin = i;
    expect(bin % RES).toBe(Math.floor(uv.u * RES));
    expect(Math.floor(bin / RES)).toBe(Math.floor((1 - uv.v) * RES));
  });
});
