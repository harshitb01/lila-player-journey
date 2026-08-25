/**
 * Viewport geometry for the map canvas.
 *
 * The minimap must keep its true aspect ratio at any container size, and telemetry must
 * stay locked to the artwork through every resize. Both are achieved by routing the
 * image and the points through the *same* fitted rectangle: the image is drawn into it,
 * and UV coordinates are mapped into it. Nothing can drift, because there is only one
 * source of geometry.
 *
 * Pure functions, no canvas or DOM access, so the alignment guarantee is directly
 * testable. See `viewport.test.ts`.
 */

import { uvToPixel, type Uv } from '../utils/coordinates';

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

/** Padding between the fitted map and the container edge, in CSS pixels. */
export const VIEWPORT_PADDING = 16;

/**
 * Largest rectangle of the given aspect ratio that fits inside `container`, centred.
 *
 * `aspect` is width / height. GrandRift's artwork is 2160x2158, so this must not assume
 * square maps.
 */
export function computeFitRect(
  container: Size,
  aspect: number,
  padding = VIEWPORT_PADDING,
): Rect {
  const availableWidth = Math.max(0, container.width - padding * 2);
  const availableHeight = Math.max(0, container.height - padding * 2);

  if (availableWidth <= 0 || availableHeight <= 0 || !Number.isFinite(aspect) || aspect <= 0) {
    return { x: padding, y: padding, width: 0, height: 0 };
  }

  // Fit by whichever axis binds first.
  let width = availableWidth;
  let height = width / aspect;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * aspect;
  }

  return {
    x: padding + (availableWidth - width) / 2,
    y: padding + (availableHeight - height) / 2,
    width,
    height,
  };
}

/**
 * Project a normalised map coordinate into canvas space.
 *
 * Delegates the flip to the validated `uvToPixel`, then offsets by the fitted rect's
 * origin. Keeping the flip in one place means the renderer cannot disagree with the
 * pipeline about which way is north.
 */
export function uvToCanvas(uv: Uv, rect: Rect): { x: number; y: number } {
  const point = uvToPixel(uv, rect);
  return { x: rect.x + point.x, y: rect.y + point.y };
}

/** Inverse of {@link uvToCanvas}, for pointer hit-testing. */
export function canvasToUv(point: { x: number; y: number }, rect: Rect): Uv {
  if (rect.width === 0 || rect.height === 0) return { u: Number.NaN, v: Number.NaN };
  return {
    u: (point.x - rect.x) / rect.width,
    v: 1 - (point.y - rect.y) / rect.height,
  };
}

/**
 * Size a canvas for the device pixel ratio.
 *
 * The backing store is sized in device pixels while the element stays sized in CSS
 * pixels, so drawing code can work purely in CSS pixels and still render crisply on
 * high-DPI displays. Returns true when the backing store changed.
 */
export function resizeCanvasToDisplaySize(
  canvas: HTMLCanvasElement,
  container: Size,
  dpr: number,
): boolean {
  const width = Math.max(1, Math.round(container.width * dpr));
  const height = Math.max(1, Math.round(container.height * dpr));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${container.width}px`;
  canvas.style.height = `${container.height}px`;
  return true;
}
