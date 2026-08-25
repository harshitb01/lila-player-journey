/**
 * World-to-minimap coordinate transformation.
 *
 * This module is deliberately dependency-free and side-effect-free: it is the single
 * source of truth for projecting LILA BLACK world coordinates onto minimap imagery,
 * and it is mirrored exactly by `scripts/coordinate_validation.py`.
 *
 * The transform is the one documented in the dataset README:
 *
 *     u = (x - originX) / scale
 *     v = (z - originZ) / scale
 *
 *     pixelX = u * size
 *     pixelY = (1 - v) * size      // image origin is top-left, so v is flipped
 *
 * Validation against all 89,104 telemetry rows is recorded in COORDINATE_VALIDATION.md.
 *
 * Two deliberate design decisions:
 *
 * 1. **Nothing is clamped.** An out-of-range result is a signal worth surfacing, not an
 *    error to be silently absorbed. Callers decide what to do with it; `isUvInBounds`
 *    and `isPixelInBounds` are provided for that purpose.
 *
 * 2. **The render size is a parameter, not the constant 1024.** The README's formula
 *    hardcodes 1024 because it assumes 1024x1024 minimaps. The shipped images are not
 *    that size (4320x4320, 2160x2158, 9000x9000), so the final scaling step is
 *    parameterised. Passing `REFERENCE_SIZE` reproduces the README's arithmetic
 *    exactly; the UV stage above it is untouched.
 */

/** The three maps in rotation. */
export type MapId = 'AmbroseValley' | 'GrandRift' | 'Lockdown';

/** Projection constants for one map, as published in the dataset README. */
export interface MapConfig {
  readonly id: MapId;
  /** Width of the mapped world region, in world units. Applied to both axes. */
  readonly scale: number;
  /** World X corresponding to u = 0. */
  readonly originX: number;
  /** World Z corresponding to v = 0. */
  readonly originZ: number;
}

/** Normalised map-space coordinate. Inside the minimap iff both components are in [0,1]. */
export interface Uv {
  readonly u: number;
  readonly v: number;
}

/** A point in image space, in pixels, with the origin at the top-left. */
export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

/** Pixel dimensions of a render target. */
export interface RenderSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The reference resolution used by the README's worked example.
 *
 * Note this is NOT the size of any shipped minimap image; it is the notional square
 * the README projects into. Real rendering should pass the actual image dimensions.
 */
export const REFERENCE_SIZE = 1024;

/**
 * Projection constants, transcribed verbatim from the dataset README.
 *
 * Validated against all 89,104 telemetry rows: every point lands inside [0,1] UV on
 * every map. Do not edit without re-running `scripts/coordinate_validation.py`.
 */
export const MAP_CONFIGS: Readonly<Record<MapId, MapConfig>> = Object.freeze({
  AmbroseValley: { id: 'AmbroseValley', scale: 900, originX: -370, originZ: -473 },
  GrandRift: { id: 'GrandRift', scale: 581, originX: -290, originZ: -290 },
  Lockdown: { id: 'Lockdown', scale: 1000, originX: -500, originZ: -500 },
});

/** All valid map ids. */
export const MAP_IDS: readonly MapId[] = Object.freeze(
  Object.keys(MAP_CONFIGS) as MapId[],
);

/** Type guard for values arriving from telemetry, where `map_id` is an untrusted string. */
export function isMapId(value: string): value is MapId {
  return Object.prototype.hasOwnProperty.call(MAP_CONFIGS, value);
}

/**
 * Look up a map's projection constants.
 *
 * @throws if the id is not one of the three known maps. Failing loudly is intentional:
 * a silent fallback would render a journey onto the wrong map.
 */
export function getMapConfig(mapId: string): MapConfig {
  const config = MAP_CONFIGS[mapId as MapId];
  if (!config) {
    throw new Error(
      `Unknown map_id "${mapId}". Expected one of: ${MAP_IDS.join(', ')}.`,
    );
  }
  return config;
}

/**
 * Project world coordinates to normalised map space.
 *
 * Only `x` and `z` participate. The `y` column is elevation in the 3D world and has no
 * bearing on a top-down projection.
 *
 * The result is NOT clamped: values outside [0,1] mean the point lies off the minimap.
 */
export function worldToUv(x: number, z: number, config: MapConfig): Uv {
  return {
    u: (x - config.originX) / config.scale,
    v: (z - config.originZ) / config.scale,
  };
}

/**
 * Invert {@link worldToUv}, recovering world coordinates from normalised map space.
 *
 * Needed for pointer hit-testing: turning a cursor position back into world space.
 */
export function uvToWorld(uv: Uv, config: MapConfig): { x: number; z: number } {
  return {
    x: uv.u * config.scale + config.originX,
    z: uv.v * config.scale + config.originZ,
  };
}

/**
 * Convert normalised map space to image pixels.
 *
 * The vertical axis is flipped because world Z increases northward while image Y
 * increases downward from a top-left origin.
 */
export function uvToPixel(uv: Uv, size: RenderSize): PixelPoint {
  return {
    x: uv.u * size.width,
    y: (1 - uv.v) * size.height,
  };
}

/** Invert {@link uvToPixel}. */
export function pixelToUv(point: PixelPoint, size: RenderSize): Uv {
  return {
    u: point.x / size.width,
    v: 1 - point.y / size.height,
  };
}

/**
 * Project world coordinates straight to image pixels.
 *
 * Defaults to the README's 1024x1024 reference square so that calling this with no
 * size reproduces the documented worked example exactly.
 */
export function worldToPixel(
  x: number,
  z: number,
  config: MapConfig,
  size: RenderSize = { width: REFERENCE_SIZE, height: REFERENCE_SIZE },
): PixelPoint {
  return uvToPixel(worldToUv(x, z, config), size);
}

/** Invert {@link worldToPixel}. */
export function pixelToWorld(
  point: PixelPoint,
  config: MapConfig,
  size: RenderSize = { width: REFERENCE_SIZE, height: REFERENCE_SIZE },
): { x: number; z: number } {
  return uvToWorld(pixelToUv(point, size), config);
}

/** True when a UV coordinate lies on the minimap. Boundaries count as inside. */
export function isUvInBounds(uv: Uv): boolean {
  return uv.u >= 0 && uv.u <= 1 && uv.v >= 0 && uv.v <= 1;
}

/** True when a pixel coordinate lies within the render target. Boundaries count as inside. */
export function isPixelInBounds(point: PixelPoint, size: RenderSize): boolean {
  return (
    point.x >= 0 && point.x <= size.width && point.y >= 0 && point.y <= size.height
  );
}
