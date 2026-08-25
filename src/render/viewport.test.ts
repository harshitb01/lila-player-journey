import { describe, expect, it } from 'vitest';

import { MAP_CONFIGS, worldToUv } from '../utils/coordinates';
import { canvasToUv, computeFitRect, uvToCanvas } from './viewport';

const NO_PADDING = 0;

describe('computeFitRect', () => {
  it('fills a container of identical aspect exactly', () => {
    const rect = computeFitRect({ width: 800, height: 800 }, 1, NO_PADDING);
    expect(rect).toEqual({ x: 0, y: 0, width: 800, height: 800 });
  });

  it('letterboxes horizontally when the container is wider than the map', () => {
    const rect = computeFitRect({ width: 1600, height: 800 }, 1, NO_PADDING);
    expect(rect.width).toBe(800);
    expect(rect.height).toBe(800);
    expect(rect.x).toBe(400); // centred
    expect(rect.y).toBe(0);
  });

  it('letterboxes vertically when the container is taller than the map', () => {
    const rect = computeFitRect({ width: 800, height: 1600 }, 1, NO_PADDING);
    expect(rect.width).toBe(800);
    expect(rect.height).toBe(800);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(400);
  });

  it('preserves a non-square aspect — GrandRift is 2160x2158, not square', () => {
    const aspect = 2160 / 2158;
    const rect = computeFitRect({ width: 1000, height: 1000 }, aspect, NO_PADDING);
    expect(rect.width / rect.height).toBeCloseTo(aspect, 10);
    expect(rect.width).toBeLessThanOrEqual(1000);
    expect(rect.height).toBeLessThanOrEqual(1000);
  });

  it('applies padding on both axes', () => {
    const rect = computeFitRect({ width: 1000, height: 1000 }, 1, 20);
    expect(rect.width).toBe(960);
    expect(rect.x).toBe(20);
  });

  it('degrades to an empty rect rather than producing negative sizes', () => {
    expect(computeFitRect({ width: 10, height: 10 }, 1, 20).width).toBe(0);
    expect(computeFitRect({ width: 0, height: 0 }, 1, 0).width).toBe(0);
  });

  it('rejects a non-finite or non-positive aspect', () => {
    expect(computeFitRect({ width: 800, height: 800 }, Number.NaN, 0).width).toBe(0);
    expect(computeFitRect({ width: 800, height: 800 }, 0, 0).width).toBe(0);
  });

  it('never exceeds the available area at any container size', () => {
    for (const width of [320, 640, 1280, 1920, 2560]) {
      for (const height of [240, 480, 900, 1440]) {
        const rect = computeFitRect({ width, height }, 4320 / 4320, 16);
        expect(rect.x + rect.width).toBeLessThanOrEqual(width - 16 + 1e-9);
        expect(rect.y + rect.height).toBeLessThanOrEqual(height - 16 + 1e-9);
      }
    }
  });
});

describe('uvToCanvas', () => {
  const rect = { x: 100, y: 50, width: 800, height: 400 };

  it('maps v=1 to the top edge and v=0 to the bottom edge', () => {
    expect(uvToCanvas({ u: 0, v: 1 }, rect)).toEqual({ x: 100, y: 50 });
    expect(uvToCanvas({ u: 0, v: 0 }, rect)).toEqual({ x: 100, y: 450 });
  });

  it('maps u=1 to the right edge', () => {
    expect(uvToCanvas({ u: 1, v: 1 }, rect)).toEqual({ x: 900, y: 50 });
  });

  it('maps the centre to the rect centre', () => {
    expect(uvToCanvas({ u: 0.5, v: 0.5 }, rect)).toEqual({ x: 500, y: 250 });
  });

  it('round-trips through canvasToUv', () => {
    for (const uv of [
      { u: 0, v: 0 },
      { u: 1, v: 1 },
      { u: 0.137, v: 0.842 },
      { u: 0.5, v: 0.5 },
    ]) {
      const back = canvasToUv(uvToCanvas(uv, rect), rect);
      expect(back.u).toBeCloseTo(uv.u, 12);
      expect(back.v).toBeCloseTo(uv.v, 12);
    }
  });
});

describe('alignment is preserved across resize', () => {
  // The guarantee that matters: a world coordinate must land on the same *relative*
  // position within the fitted map at every container size. If image and points ever
  // used different geometry, this would drift.
  const config = MAP_CONFIGS.AmbroseValley;
  const samples: [number, number][] = [
    [-301.45, -355.55],
    [-324.97, 360.76],
    [301.79, -380.01],
    [0, 0],
  ];

  const containers: [number, number][] = [
    [1440, 900],
    [1024, 768],
    [1920, 1080],
    [800, 1200],
    [2560, 1440],
    [1101, 733],
  ];

  it('keeps every point at a constant fraction of the fitted rect', () => {
    for (const [x, z] of samples) {
      const uv = worldToUv(x, z, config);
      const fractions = containers.map(([width, height]) => {
        const rect = computeFitRect({ width, height }, 1);
        const point = uvToCanvas(uv, rect);
        return {
          fx: (point.x - rect.x) / rect.width,
          fy: (point.y - rect.y) / rect.height,
        };
      });
      const first = fractions[0]!;
      for (const f of fractions.slice(1)) {
        expect(f.fx).toBeCloseTo(first.fx, 12);
        expect(f.fy).toBeCloseTo(first.fy, 12);
      }
    }
  });

  it('keeps points inside the fitted rect for real telemetry extremes', () => {
    const extremes: [number, number][] = [
      [-324.97, -380.01],
      [301.79, 360.76],
    ];
    for (const [width, height] of containers) {
      const rect = computeFitRect({ width, height }, 1);
      for (const [x, z] of extremes) {
        const point = uvToCanvas(worldToUv(x, z, config), rect);
        expect(point.x).toBeGreaterThanOrEqual(rect.x - 1e-9);
        expect(point.x).toBeLessThanOrEqual(rect.x + rect.width + 1e-9);
        expect(point.y).toBeGreaterThanOrEqual(rect.y - 1e-9);
        expect(point.y).toBeLessThanOrEqual(rect.y + rect.height + 1e-9);
      }
    }
  });
});
