/**
 * Canvas drawing for the map workspace.
 *
 * Imperative and framework-free on purpose: React owns the DOM, this owns the pixels.
 * Everything is drawn in CSS-pixel space; the caller applies the device-pixel-ratio
 * transform once before calling in.
 *
 * Journeys are drawn as polylines, never as one marker per movement event. At ~5 s
 * sampling a typical journey is ~60 samples; 836 of them would be 50,000 discrete
 * markers, which reads as noise and says nothing about direction or route.
 *
 * Heatmaps and playback are not implemented yet.
 */

import { GAP_SECONDS } from '../analysis/journeyStats';
import type { MapModel, MapTracks } from '../data/model';
import { MOVEMENT_CODES } from '../data/types';
import {
  EVENT_CODES,
  MARKERS_BY_Z,
  MARKER_BY_CODE,
  SHAPES,
  type EventGroup,
} from './eventMarkers';
import { windowForJourney } from './playback';
import type { UvRect } from './region';
import { type Rect, uvToCanvas } from './viewport';

/**
 * Humans and bots are separated by **line style and weight**, not colour alone: humans
 * are solid and slightly heavier, bots are dashed and lighter. The distinction survives
 * greyscale printing and every form of colour blindness. Hue is a secondary cue only.
 */
/**
 * Upper bound on event codes, so per-class marker buckets can be a flat array indexed
 * by code (an array index in the hot loop, rather than a Map hash).
 */
const EVENT_CODE_SLOTS = 16;

export const PATH_STYLE = {
  human: {
    stroke: '#dbe6f5',
    dash: [] as number[],
    width: 1.2,
    /** Alpha used when many journeys are drawn at once. */
    bulkAlpha: 0.24,
    soloAlpha: 0.95,
  },
  bot: {
    stroke: '#8b98ad',
    dash: [2.5, 3] as number[],
    width: 0.9,
    bulkAlpha: 0.16,
    soloAlpha: 0.8,
  },
  selected: {
    stroke: '#4da3ff',
    haloStroke: 'rgba(77, 163, 255, 0.22)',
    width: 2.2,
    haloWidth: 7,
  },
  /** Segments spanning a sampling gap: position at both ends is known, the route is not. */
  gap: {
    stroke: 'rgba(190, 205, 225, 0.30)',
    selectedStroke: 'rgba(77, 163, 255, 0.55)',
    dash: [1, 4] as number[],
    width: 1,
  },
} as const;

export interface RenderOptions {
  rect: Rect;
  tracks: MapTracks | null;
  /** Journey slots to draw. Null means every slot. */
  visibleSlots: Uint8Array | null;
  /** Slot -> 1 when the journey is a bot. */
  slotIsBot: Uint8Array | null;
  /** Slot of the selected journey, or -1. */
  selectedSlot: number;
  /** Below this many visible journeys, paths are drawn at full strength. */
  soloThreshold: number;
  /** Which event groups are currently shown. */
  eventGroups: Record<EventGroup, boolean>;
  /**
   * Match-relative seconds to clip to, or null to show the whole match.
   *
   * Everything drawn is derived from this value alone, so the same time always yields
   * the same frame however playback arrived there.
   */
  playbackTime: number | null;
  /**
   * Pre-rendered heatmap, or null. Supplied as a ready canvas rather than raw counts so
   * the render path never re-aggregates: binning happens once per filter/mode change.
   */
  heatmap: CanvasImageSource | null;
  /** Committed or in-progress region selection, in UV space. */
  region: UvRect | null;
}

export function clear(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
}

export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement | null,
  rect: Rect,
): void {
  if (rect.width <= 0 || rect.height <= 0) return;

  if (image && image.complete && image.naturalWidth > 0) {
    ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    return;
  }

  // Artwork unavailable: draw the play area so telemetry still reads correctly.
  ctx.save();
  ctx.fillStyle = '#12151a';
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = '#2c323c';
  ctx.lineWidth = 1;
  const step = rect.width / 16;
  ctx.beginPath();
  for (let i = 1; i < 16; i++) {
    ctx.moveTo(rect.x + i * step, rect.y);
    ctx.lineTo(rect.x + i * step, rect.y + rect.height);
    ctx.moveTo(rect.x, rect.y + (i * rect.height) / 16);
    ctx.lineTo(rect.x + rect.width, rect.y + (i * rect.height) / 16);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawMapFrame(ctx: CanvasRenderingContext2D, rect: Rect): void {
  if (rect.width <= 0) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(120, 132, 150, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  ctx.restore();
}

/**
 * Movement sample indices for one journey slot, in time order.
 *
 * With `playbackTime` set, the slice is clipped to what has already happened. The window
 * is found by binary search, so clipping costs O(log n) rather than a scan.
 */
function movementIndices(
  tracks: MapTracks,
  slot: number,
  playbackTime: number | null = null,
): number[] {
  const { start, end } = windowForJourney(tracks, slot, playbackTime);
  const out: number[] = [];
  for (let i = start; i < end; i++) {
    if (MOVEMENT_CODES.has(tracks.eventType[i] ?? -1)) out.push(i);
  }
  return out;
}

function pointAt(tracks: MapTracks, index: number, rect: Rect) {
  return uvToCanvas({ u: tracks.u[index] ?? 0, v: tracks.v[index] ?? 0 }, rect);
}

/**
 * Accumulates one actor class's polylines into a single path, so the whole cohort costs
 * one `stroke()` rather than one per journey. Gap segments are collected separately
 * because they are drawn in a different style.
 */
function buildCohortPaths(
  tracks: MapTracks,
  rect: Rect,
  slots: number[],
  playbackTime: number | null = null,
): { solid: Path2D; gaps: Path2D } {
  const solid = new Path2D();
  const gaps = new Path2D();

  for (const slot of slots) {
    const indices = movementIndices(tracks, slot, playbackTime);
    if (indices.length < 2) continue;

    let previous = indices[0]!;
    let previousPoint = pointAt(tracks, previous, rect);
    for (let k = 1; k < indices.length; k++) {
      const current = indices[k]!;
      const point = pointAt(tracks, current, rect);
      const dt = (tracks.tRel[current] ?? 0) - (tracks.tRel[previous] ?? 0);
      const target = dt > GAP_SECONDS ? gaps : solid;
      target.moveTo(previousPoint.x, previousPoint.y);
      target.lineTo(point.x, point.y);
      previous = current;
      previousPoint = point;
    }
  }
  return { solid, gaps };
}

/**
 * A journey with fewer than two movement samples cannot be a polyline.
 *
 * It is still drawn — as a small ring at its single known position. Omitting it would
 * imply the actor was absent, when in fact the telemetry is simply too sparse to draw a
 * route. Three journeys in this dataset are in that state.
 */
function drawSparseMarkers(
  ctx: CanvasRenderingContext2D,
  tracks: MapTracks,
  rect: Rect,
  slots: number[],
  isBot: boolean,
  playbackTime: number | null = null,
): void {
  const style = isBot ? PATH_STYLE.bot : PATH_STYLE.human;
  ctx.save();
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.85;
  for (const slot of slots) {
    const indices = movementIndices(tracks, slot, playbackTime);
    if (indices.length !== 1) continue;
    const point = pointAt(tracks, indices[0]!, rect);
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Start and end markers for a single highlighted journey.
 *
 * Shape carries the meaning — a hollow ring for the first recorded position, a filled
 * square for the last — so the direction of travel is readable without relying on hue.
 * The end marker is explicitly "last recorded position", not "death": journeys end for
 * reasons the telemetry does not record.
 */
function drawEndpoints(
  ctx: CanvasRenderingContext2D,
  tracks: MapTracks,
  rect: Rect,
  slot: number,
  playbackTime: number | null = null,
): void {
  const indices = movementIndices(tracks, slot, playbackTime);
  if (indices.length === 0) return;

  const first = pointAt(tracks, indices[0]!, rect);
  const last = pointAt(tracks, indices[indices.length - 1]!, rect);

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = PATH_STYLE.selected.stroke;
  ctx.fillStyle = '#0b0d10';

  ctx.beginPath();
  ctx.arc(first.x, first.y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  if (indices.length > 1 && playbackTime === null) {
    // Only meaningful for a completed route; during playback the trailing point is
    // "where they are now", drawn by drawCurrentPositions instead.
    ctx.fillStyle = PATH_STYLE.selected.stroke;
    ctx.fillRect(last.x - 3.5, last.y - 3.5, 7, 7);
  }
  ctx.restore();
}

function strokePath(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  stroke: string,
  width: number,
  dash: readonly number[],
  alpha: number,
): void {
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(dash as number[]);
  ctx.stroke(path);
  ctx.restore();
}

/**
 * Draws every visible journey.
 *
 * Cost is three `stroke()` calls for the whole cohort plus a few for the selection,
 * regardless of how many journeys are visible.
 */
export function drawJourneys(ctx: CanvasRenderingContext2D, options: RenderOptions): void {
  const { tracks, rect, visibleSlots, slotIsBot, selectedSlot, soloThreshold, playbackTime } =
    options;
  if (!tracks || rect.width <= 0) return;

  const humanSlots: number[] = [];
  const botSlots: number[] = [];
  for (let slot = 0; slot < tracks.journeyCount; slot++) {
    if (visibleSlots && !visibleSlots[slot]) continue;
    if (slot === selectedSlot) continue; // drawn separately, on top
    (slotIsBot?.[slot] === 1 ? botSlots : humanSlots).push(slot);
  }

  const visibleCount = humanSlots.length + botSlots.length + (selectedSlot >= 0 ? 1 : 0);
  const sparse = visibleCount <= soloThreshold;
  // With a selection present, unselected journeys recede so the selected one dominates.
  const dim = selectedSlot >= 0 ? 0.45 : 1;

  for (const [slots, style, isBot] of [
    [humanSlots, PATH_STYLE.human, false],
    [botSlots, PATH_STYLE.bot, true],
  ] as const) {
    if (slots.length === 0) continue;
    const { solid, gaps } = buildCohortPaths(tracks, rect, slots, playbackTime);
    const alpha = (sparse ? style.soloAlpha : style.bulkAlpha) * dim;

    strokePath(ctx, gaps, PATH_STYLE.gap.stroke, PATH_STYLE.gap.width, PATH_STYLE.gap.dash, alpha * 0.8);
    strokePath(ctx, solid, style.stroke, style.width, style.dash, alpha);
    if (sparse) drawSparseMarkers(ctx, tracks, rect, slots, isBot, playbackTime);
  }

  if (selectedSlot >= 0) {
    const { solid, gaps } = buildCohortPaths(tracks, rect, [selectedSlot], playbackTime);
    const selected = PATH_STYLE.selected;
    const isBot = slotIsBot?.[selectedSlot] === 1;
    // A soft halo lifts the selected route off a busy background without changing hue.
    strokePath(ctx, solid, selected.haloStroke, selected.haloWidth, [], 1);
    strokePath(ctx, gaps, PATH_STYLE.gap.selectedStroke, PATH_STYLE.gap.width + 0.5, PATH_STYLE.gap.dash, 1);
    strokePath(
      ctx,
      solid,
      selected.stroke,
      selected.width,
      isBot ? PATH_STYLE.bot.dash : PATH_STYLE.human.dash,
      1,
    );
    drawEndpoints(ctx, tracks, rect, selectedSlot, playbackTime);
  }
}

/**
 * Each visible actor's latest known position at the playhead.
 *
 * "Latest known" is literal: the most recent sample at or before `playbackTime`. An
 * actor whose first sample is still in the future is drawn not at all — they have no
 * recorded position yet, and inventing one would be fiction. An actor whose telemetry
 * has stopped keeps showing their last known position rather than disappearing, since
 * the absence of later samples is not evidence they left.
 *
 * Shape follows the same rule as the routes: filled disc for humans, hollow ring for
 * bots, so the cue survives greyscale.
 */
export function drawCurrentPositions(
  ctx: CanvasRenderingContext2D,
  options: RenderOptions,
): void {
  const { tracks, rect, visibleSlots, slotIsBot, selectedSlot, playbackTime } = options;
  if (!tracks || rect.width <= 0 || playbackTime === null) return;

  ctx.save();
  for (let slot = 0; slot < tracks.journeyCount; slot++) {
    if (visibleSlots && !visibleSlots[slot]) continue;
    const indices = movementIndices(tracks, slot, playbackTime);
    if (indices.length === 0) continue; // not yet on the map

    const point = pointAt(tracks, indices[indices.length - 1]!, rect);
    const isBot = slotIsBot?.[slot] === 1;
    const isSelected = slot === selectedSlot;
    const radius = isSelected ? 5 : 3.6;

    if (isSelected) {
      ctx.beginPath();
      ctx.fillStyle = 'rgba(77, 163, 255, 0.20)';
      ctx.arc(point.x, point.y, radius + 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.lineWidth = 1.6;
    if (isBot) {
      ctx.fillStyle = '#0b0d10';
      ctx.fill();
      ctx.strokeStyle = isSelected ? PATH_STYLE.selected.stroke : PATH_STYLE.bot.stroke;
      ctx.stroke();
    } else {
      ctx.fillStyle = isSelected ? PATH_STYLE.selected.stroke : PATH_STYLE.human.stroke;
      ctx.fill();
      ctx.strokeStyle = 'rgba(8, 10, 13, 0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Draws the discrete-event layer.
 *
 * One `Path2D` per event class means the whole layer costs at most six draw calls, even
 * with ~12,000 loot markers on screen. Classes are painted in ascending z so that rare,
 * high-signal events sit above common ones.
 *
 * Positions come from the same UV values as the paths, so markers cannot drift from the
 * route that produced them.
 */
export function drawEvents(ctx: CanvasRenderingContext2D, options: RenderOptions): void {
  const { tracks, rect, visibleSlots, eventGroups, playbackTime } = options;
  if (!tracks || rect.width <= 0) return;

  // One Path2D per enabled marker class, indexed by event code so the lookup inside the
  // point loop is an array index rather than a hash. Previously this function made a
  // full pass over every point for EACH marker class — six passes over ~60k points on
  // Ambrose Valley. Bucketing in a single pass does the same work once.
  const buckets: (Path2D | null)[] = new Array(EVENT_CODE_SLOTS).fill(null);
  const counts: number[] = new Array(EVENT_CODE_SLOTS).fill(0);
  const shapeFor: (((p: Path2D, x: number, y: number, r: number) => void) | null)[] =
    new Array(EVENT_CODE_SLOTS).fill(null);
  const radiusFor: number[] = new Array(EVENT_CODE_SLOTS).fill(0);
  let anyEnabled = false;
  for (const spec of MARKERS_BY_Z) {
    if (!eventGroups[spec.group]) continue;
    buckets[spec.code] = new Path2D();
    shapeFor[spec.code] = SHAPES[spec.shape];
    radiusFor[spec.code] = spec.radius;
    anyEnabled = true;
  }
  if (!anyEnabled) return;

  for (let i = 0; i < tracks.pointCount; i++) {
    const code = tracks.eventType[i] ?? -1;
    const path = buckets[code];
    if (!path) continue;
    const slot = tracks.journeySlot[i] ?? 0;
    if (visibleSlots && !visibleSlots[slot]) continue;
    // Only events that have already occurred at the playhead.
    if (playbackTime !== null && (tracks.tRel[i] ?? 0) > playbackTime) continue;

    const x = rect.x + (tracks.u[i] ?? 0) * rect.width;
    const y = rect.y + (1 - (tracks.v[i] ?? 0)) * rect.height;
    shapeFor[code]!(path, x, y, radiusFor[code]!);
    counts[code]!++;
  }

  // Stroke in ascending z so rare, high-signal classes sit above common ones.
  for (const spec of MARKERS_BY_Z) {
    const path = buckets[spec.code];
    if (!path || counts[spec.code] === 0) continue;

    ctx.save();
    ctx.globalAlpha = spec.alpha;
    if (spec.mode === 'fill') {
      ctx.fillStyle = spec.colour;
      ctx.fill(path);
      // A dark outline keeps solid markers legible over bright map artwork.
      ctx.strokeStyle = 'rgba(8, 10, 13, 0.75)';
      ctx.lineWidth = 0.8;
      ctx.stroke(path);
    } else {
      ctx.strokeStyle = spec.colour;
      ctx.lineWidth = spec.radius > 4 ? 1.8 : 1.5;
      ctx.lineCap = 'round';
      ctx.stroke(path);
    }
    ctx.restore();
  }
}

export interface PickedEvent {
  /** Index into the map's flat point arrays. */
  index: number;
  slot: number;
  code: number;
  tRel: number;
  worldX: number;
  worldZ: number;
  canvasX: number;
  canvasY: number;
}

/**
 * Nearest visible event marker to a canvas point.
 *
 * Scans in reverse z so that a rare marker stacked on top of a common one wins the hover,
 * matching what the eye sees.
 */
export function pickEvent(
  tracks: MapTracks,
  rect: Rect,
  visibleSlots: Uint8Array | null,
  eventGroups: Record<EventGroup, boolean>,
  point: { x: number; y: number },
  threshold = 7,
  playbackTime: number | null = null,
): PickedEvent | null {
  let best: PickedEvent | null = null;
  let bestScore = Infinity;

  for (let i = 0; i < tracks.pointCount; i++) {
    const code = tracks.eventType[i] ?? -1;
    if (!EVENT_CODES.has(code)) continue;
    const spec = MARKER_BY_CODE.get(code);
    if (!spec || !eventGroups[spec.group]) continue;

    const slot = tracks.journeySlot[i] ?? 0;
    if (visibleSlots && !visibleSlots[slot]) continue;
    if (playbackTime !== null && (tracks.tRel[i] ?? 0) > playbackTime) continue;

    const x = rect.x + (tracks.u[i] ?? 0) * rect.width;
    const y = rect.y + (1 - (tracks.v[i] ?? 0)) * rect.height;
    const dx = x - point.x;
    const dy = y - point.y;
    const distance = Math.hypot(dx, dy);
    const reach = Math.max(threshold, spec.radius + 3);
    if (distance > reach) continue;

    // Prefer the higher-z marker; break ties by proximity.
    const score = distance - spec.z * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = {
        index: i,
        slot,
        code,
        tRel: tracks.tRel[i] ?? 0,
        worldX: tracks.worldX[i] ?? 0,
        worldZ: tracks.worldZ[i] ?? 0,
        canvasX: x,
        canvasY: y,
      };
    }
  }
  return best;
}

/**
 * Draws the heatmap between the artwork and the telemetry.
 *
 * Sitting under the paths and markers keeps both readable: the field reads as terrain
 * shading rather than as something occluding the routes drawn on top of it. The source
 * is a small offscreen canvas scaled up with smoothing enabled, which is what turns
 * discrete bins into a continuous field.
 */
export function drawHeatmap(ctx: CanvasRenderingContext2D, options: RenderOptions): void {
  const { heatmap, rect } = options;
  if (!heatmap || rect.width <= 0) return;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(heatmap, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

/**
 * Draws the region selection rectangle: a dashed outline with a faint fill.
 *
 * Drawn on top of everything else so the boundary of what is being measured is never
 * ambiguous, including while the artwork or a heatmap sits underneath it.
 */
export function drawRegionMarquee(ctx: CanvasRenderingContext2D, options: RenderOptions): void {
  const { region, rect } = options;
  if (!region || rect.width <= 0) return;

  const a = uvToCanvas({ u: region.u0, v: region.v1 }, rect); // top-left
  const b = uvToCanvas({ u: region.u1, v: region.v0 }, rect); // bottom-right
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);

  ctx.save();
  ctx.fillStyle = 'rgba(77, 163, 255, 0.10)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(77, 163, 255, 0.9)';
  ctx.lineWidth = 1.25;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.restore();
}

/** Renders one frame. */
export function render(
  ctx: CanvasRenderingContext2D,
  canvas: { width: number; height: number },
  map: MapModel | null,
  image: HTMLImageElement | null,
  options: RenderOptions,
): void {
  clear(ctx, canvas.width, canvas.height);
  if (!map) return;

  drawMinimap(ctx, image, options.rect);
  drawHeatmap(ctx, options);
  drawJourneys(ctx, options);
  drawEvents(ctx, options);
  drawCurrentPositions(ctx, options);
  drawRegionMarquee(ctx, options);
  drawMapFrame(ctx, options.rect);
}

/**
 * Nearest visible journey to a canvas point.
 *
 * Linear over the map's movement samples — at most ~60,000 comparisons, well under a
 * frame, and far simpler than maintaining a spatial index that would need rebuilding on
 * every filter change.
 *
 * @returns the slot, or -1 when nothing is within `threshold` CSS pixels.
 */
export function pickJourney(
  tracks: MapTracks,
  rect: Rect,
  visibleSlots: Uint8Array | null,
  point: { x: number; y: number },
  threshold = 10,
  playbackTime: number | null = null,
): number {
  let bestSlot = -1;
  let bestDistanceSq = threshold * threshold;

  for (let i = 0; i < tracks.pointCount; i++) {
    if (!MOVEMENT_CODES.has(tracks.eventType[i] ?? -1)) continue;
    const slot = tracks.journeySlot[i] ?? 0;
    if (visibleSlots && !visibleSlots[slot]) continue;
    if (playbackTime !== null && (tracks.tRel[i] ?? 0) > playbackTime) continue;

    const x = rect.x + (tracks.u[i] ?? 0) * rect.width;
    const y = rect.y + (1 - (tracks.v[i] ?? 0)) * rect.height;
    const dx = x - point.x;
    const dy = y - point.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      bestSlot = slot;
    }
  }
  return bestSlot;
}
