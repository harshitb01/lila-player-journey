import { describe, expect, it } from 'vitest';

import {
  MAP_CONFIGS,
  MAP_IDS,
  REFERENCE_SIZE,
  getMapConfig,
  isMapId,
  isPixelInBounds,
  isUvInBounds,
  pixelToUv,
  pixelToWorld,
  uvToPixel,
  uvToWorld,
  worldToPixel,
  worldToUv,
  type MapConfig,
} from './coordinates';

const AMBROSE = MAP_CONFIGS.AmbroseValley;
const GRAND_RIFT = MAP_CONFIGS.GrandRift;
const LOCKDOWN = MAP_CONFIGS.Lockdown;

const REFERENCE = { width: REFERENCE_SIZE, height: REFERENCE_SIZE };

describe('map configuration', () => {
  it('matches the constants published in the dataset README', () => {
    expect(AMBROSE).toEqual({
      id: 'AmbroseValley',
      scale: 900,
      originX: -370,
      originZ: -473,
    });
    expect(GRAND_RIFT).toEqual({
      id: 'GrandRift',
      scale: 581,
      originX: -290,
      originZ: -290,
    });
    expect(LOCKDOWN).toEqual({
      id: 'Lockdown',
      scale: 1000,
      originX: -500,
      originZ: -500,
    });
  });

  it('exposes exactly the three maps in rotation', () => {
    expect([...MAP_IDS].sort()).toEqual(['AmbroseValley', 'GrandRift', 'Lockdown']);
  });

  it('identifies valid map ids and rejects anything else', () => {
    expect(isMapId('AmbroseValley')).toBe(true);
    expect(isMapId('Ambrose Valley')).toBe(false);
    expect(isMapId('ambrosevalley')).toBe(false);
    expect(isMapId('')).toBe(false);
  });

  it('throws on an unknown map rather than falling back to a default', () => {
    // A silent fallback would draw a journey onto the wrong map, which is worse
    // than a crash: it produces a plausible-looking but false picture.
    expect(() => getMapConfig('Atlantis')).toThrowError(/Unknown map_id "Atlantis"/);
    expect(() => getMapConfig('')).toThrowError(/Unknown map_id/);
  });

  it('resolves each known map to its config', () => {
    for (const id of MAP_IDS) {
      expect(getMapConfig(id)).toBe(MAP_CONFIGS[id]);
    }
  });

  it('freezes the config so a caller cannot corrupt the projection at runtime', () => {
    expect(Object.isFrozen(MAP_CONFIGS)).toBe(true);
  });
});

describe("README worked example (AmbroseValley, x=-301.45, z=-355.55)", () => {
  // The dataset README documents this exact case:
  //   u = (-301.45 - (-370)) / 900 = 68.55 / 900  = 0.0762
  //   v = (-355.55 - (-473)) / 900 = 117.45 / 900 = 0.1305
  //   pixel_x = 0.0762 * 1024 = 78
  //   pixel_y = (1 - 0.1305) * 1024 = 890
  const x = -301.45;
  const z = -355.55;

  it('reproduces the documented UV values', () => {
    const uv = worldToUv(x, z, AMBROSE);
    expect(uv.u).toBeCloseTo(0.0762, 4);
    expect(uv.v).toBeCloseTo(0.1305, 4);
  });

  it('reproduces the documented pixel values', () => {
    const p = worldToPixel(x, z, AMBROSE);
    expect(Math.round(p.x)).toBe(78);
    expect(Math.round(p.y)).toBe(890);
  });

  it('defaults to the reference size, matching the README exactly', () => {
    expect(worldToPixel(x, z, AMBROSE)).toEqual(
      worldToPixel(x, z, AMBROSE, REFERENCE),
    );
  });
});

describe('worldToUv', () => {
  it('maps the origin corner to (0,0)', () => {
    const uv = worldToUv(AMBROSE.originX, AMBROSE.originZ, AMBROSE);
    expect(uv.u).toBe(0);
    expect(uv.v).toBe(0);
  });

  it('maps the far corner to (1,1)', () => {
    const uv = worldToUv(
      AMBROSE.originX + AMBROSE.scale,
      AMBROSE.originZ + AMBROSE.scale,
      AMBROSE,
    );
    expect(uv.u).toBeCloseTo(1, 12);
    expect(uv.v).toBeCloseTo(1, 12);
  });

  it('maps the centre to (0.5,0.5)', () => {
    const uv = worldToUv(
      AMBROSE.originX + AMBROSE.scale / 2,
      AMBROSE.originZ + AMBROSE.scale / 2,
      AMBROSE,
    );
    expect(uv.u).toBeCloseTo(0.5, 12);
    expect(uv.v).toBeCloseTo(0.5, 12);
  });

  it('is linear: doubling the world offset doubles u', () => {
    const a = worldToUv(AMBROSE.originX + 100, AMBROSE.originZ, AMBROSE);
    const b = worldToUv(AMBROSE.originX + 200, AMBROSE.originZ, AMBROSE);
    expect(b.u).toBeCloseTo(a.u * 2, 12);
  });

  it('applies the same scale to both axes', () => {
    const uv = worldToUv(AMBROSE.originX + 450, AMBROSE.originZ + 450, AMBROSE);
    expect(uv.u).toBeCloseTo(uv.v, 12);
  });

  it('ignores elevation entirely — y is not a parameter', () => {
    // Guards against a future refactor accidentally introducing y into the projection.
    expect(worldToUv.length).toBe(3);
  });

  it('does NOT clamp values that fall off the map', () => {
    const below = worldToUv(AMBROSE.originX - 900, AMBROSE.originZ, AMBROSE);
    expect(below.u).toBe(-1);
    const above = worldToUv(AMBROSE.originX + 1800, AMBROSE.originZ, AMBROSE);
    expect(above.u).toBe(2);
  });

  it('uses per-map constants, not a shared default', () => {
    // Same world point, three maps -> three different UVs.
    const results = MAP_IDS.map((id) => worldToUv(0, 0, MAP_CONFIGS[id]));
    const us = new Set(results.map((r) => r.u.toFixed(6)));
    expect(us.size).toBe(3);
  });
});

describe('uvToPixel', () => {
  it('flips the vertical axis: v=0 is the BOTTOM of the image', () => {
    expect(uvToPixel({ u: 0, v: 0 }, REFERENCE)).toEqual({ x: 0, y: 1024 });
  });

  it('places v=1 at the top of the image', () => {
    expect(uvToPixel({ u: 0, v: 1 }, REFERENCE)).toEqual({ x: 0, y: 0 });
  });

  it('does not flip the horizontal axis', () => {
    expect(uvToPixel({ u: 1, v: 1 }, REFERENCE)).toEqual({ x: 1024, y: 0 });
  });

  it('maps the centre to the image centre', () => {
    expect(uvToPixel({ u: 0.5, v: 0.5 }, REFERENCE)).toEqual({ x: 512, y: 512 });
  });

  it('honours a non-square render target on each axis independently', () => {
    // GrandRift's shipped minimap is 2160x2158, so width and height must not be
    // assumed equal.
    const size = { width: 2160, height: 2158 };
    expect(uvToPixel({ u: 1, v: 0 }, size)).toEqual({ x: 2160, y: 2158 });
    expect(uvToPixel({ u: 0.5, v: 0.5 }, size)).toEqual({ x: 1080, y: 1079 });
  });

  it('scales to the real minimap resolutions', () => {
    expect(uvToPixel({ u: 1, v: 1 }, { width: 4320, height: 4320 })).toEqual({
      x: 4320,
      y: 0,
    });
    expect(uvToPixel({ u: 1, v: 1 }, { width: 9000, height: 9000 })).toEqual({
      x: 9000,
      y: 0,
    });
  });
});

describe('round trips', () => {
  const samples: ReadonlyArray<readonly [MapConfig, number, number]> = [
    [AMBROSE, -301.45, -355.55],
    [AMBROSE, -324.97, 360.76],
    [AMBROSE, 301.79, -380.01],
    [GRAND_RIFT, -225.9, -194.0],
    [GRAND_RIFT, 256.62, 170.11],
    [LOCKDOWN, -406.63, -285.1],
    [LOCKDOWN, 348.36, 329.24],
    [LOCKDOWN, 0, 0],
  ];

  it.each(samples)('world -> uv -> world is lossless (%s)', (config, x, z) => {
    const back = uvToWorld(worldToUv(x, z, config), config);
    expect(back.x).toBeCloseTo(x, 9);
    expect(back.z).toBeCloseTo(z, 9);
  });

  it.each(samples)('world -> pixel -> world is lossless (%s)', (config, x, z) => {
    const back = pixelToWorld(worldToPixel(x, z, config), config);
    expect(back.x).toBeCloseTo(x, 9);
    expect(back.z).toBeCloseTo(z, 9);
  });

  it('uv -> pixel -> uv is lossless on a non-square target', () => {
    const size = { width: 2160, height: 2158 };
    const uv = { u: 0.137, v: 0.842 };
    const back = pixelToUv(uvToPixel(uv, size), size);
    expect(back.u).toBeCloseTo(uv.u, 12);
    expect(back.v).toBeCloseTo(uv.v, 12);
  });
});

describe('bounds predicates', () => {
  it('treats the boundary as inside', () => {
    expect(isUvInBounds({ u: 0, v: 0 })).toBe(true);
    expect(isUvInBounds({ u: 1, v: 1 })).toBe(true);
  });

  it('rejects points off any edge', () => {
    expect(isUvInBounds({ u: -0.0001, v: 0.5 })).toBe(false);
    expect(isUvInBounds({ u: 1.0001, v: 0.5 })).toBe(false);
    expect(isUvInBounds({ u: 0.5, v: -0.0001 })).toBe(false);
    expect(isUvInBounds({ u: 0.5, v: 1.0001 })).toBe(false);
  });

  it('rejects NaN, which must never be treated as on-map', () => {
    expect(isUvInBounds({ u: Number.NaN, v: 0.5 })).toBe(false);
    expect(isUvInBounds({ u: 0.5, v: Number.NaN })).toBe(false);
  });

  it('checks pixel bounds against the given render size', () => {
    const size = { width: 4320, height: 4320 };
    expect(isPixelInBounds({ x: 0, y: 0 }, size)).toBe(true);
    expect(isPixelInBounds({ x: 4320, y: 4320 }, size)).toBe(true);
    expect(isPixelInBounds({ x: -1, y: 0 }, size)).toBe(false);
    expect(isPixelInBounds({ x: 0, y: 4321 }, size)).toBe(false);
  });
});

describe('real telemetry extremes stay on the minimap', () => {
  // The most extreme world coordinate observed per map across all 89,104 rows,
  // as measured by scripts/analyze_dataset.py. These must all project inside [0,1].
  const extremes: ReadonlyArray<readonly [MapConfig, number, number, number, number]> = [
    // config, minX, maxX, minZ, maxZ
    [AMBROSE, -324.97, 301.79, -380.01, 360.76],
    [GRAND_RIFT, -225.9, 256.62, -194.0, 170.11],
    [LOCKDOWN, -406.63, 348.36, -285.1, 329.24],
  ];

  it.each(extremes)(
    'every corner of the observed extent is on-map (%s)',
    (config, minX, maxX, minZ, maxZ) => {
      for (const x of [minX, maxX]) {
        for (const z of [minZ, maxZ]) {
          const uv = worldToUv(x, z, config);
          expect(isUvInBounds(uv)).toBe(true);
          const p = worldToPixel(x, z, config);
          expect(isPixelInBounds(p, REFERENCE)).toBe(true);
        }
      }
    },
  );
});
