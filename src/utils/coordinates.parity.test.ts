import { describe, expect, it } from 'vitest';

import fixture from './__fixtures__/projection-vectors.json';
import {
  REFERENCE_SIZE,
  getMapConfig,
  isUvInBounds,
  worldToPixel,
  worldToUv,
} from './coordinates';

/**
 * Cross-language parity.
 *
 * The offline pipeline projects coordinates in Python; the browser projects them in
 * TypeScript. If those two implementations ever drift, every rendered position is
 * silently wrong while both test suites still pass individually.
 *
 * `scripts/coordinate_validation.py` samples real telemetry, computes the projection,
 * and writes the results to the fixture consumed here. This test asserts the two
 * implementations agree to within floating-point noise on real data.
 *
 * Regenerate with:
 *   python scripts/coordinate_validation.py
 */

interface Vector {
  mapId: string;
  x: number;
  z: number;
  u: number;
  v: number;
  pixelX: number;
  pixelY: number;
}

const vectors = fixture.vectors as Vector[];

/** Both languages use IEEE-754 doubles and the same operation order. */
const EPSILON = 1e-12;

describe('Python <-> TypeScript projection parity', () => {
  it('loads a non-trivial fixture covering every map', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(300);
    const maps = new Set(vectors.map((v) => v.mapId));
    expect([...maps].sort()).toEqual(['AmbroseValley', 'GrandRift', 'Lockdown']);
  });

  it('was generated against the same reference size', () => {
    expect(fixture.referenceSize).toBe(REFERENCE_SIZE);
  });

  it('agrees with Python on UV for every sampled real position', () => {
    let worstU = 0;
    let worstV = 0;
    for (const vec of vectors) {
      const uv = worldToUv(vec.x, vec.z, getMapConfig(vec.mapId));
      worstU = Math.max(worstU, Math.abs(uv.u - vec.u));
      worstV = Math.max(worstV, Math.abs(uv.v - vec.v));
    }
    expect(worstU).toBeLessThan(EPSILON);
    expect(worstV).toBeLessThan(EPSILON);
  });

  it('agrees with Python on pixel coordinates for every sampled real position', () => {
    let worstX = 0;
    let worstY = 0;
    for (const vec of vectors) {
      const p = worldToPixel(vec.x, vec.z, getMapConfig(vec.mapId));
      worstX = Math.max(worstX, Math.abs(p.x - vec.pixelX));
      worstY = Math.max(worstY, Math.abs(p.y - vec.pixelY));
    }
    expect(worstX).toBeLessThan(EPSILON);
    expect(worstY).toBeLessThan(EPSILON);
  });

  it('places every sampled real position on the minimap', () => {
    const offMap = vectors.filter(
      (vec) => !isUvInBounds(worldToUv(vec.x, vec.z, getMapConfig(vec.mapId))),
    );
    expect(offMap).toEqual([]);
  });
});
