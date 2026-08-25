/**
 * Marker geometry for discrete telemetry events.
 *
 * Every event class has its own **shape**, not merely its own colour, so the layer stays
 * readable in greyscale and for colour-blind users. Shape carries the category, colour
 * reinforces it:
 *
 *     kills dealt     angular  — star (vs player), cross (vs bot)
 *     deaths suffered blunt    — triangle (by player), diamond (by bot)
 *     environment     hexagon  — storm
 *     items           circle   — loot
 *
 * Markers of one class accumulate into a single `Path2D`, so the whole class costs one
 * fill or stroke regardless of how many events it contains. Nothing here creates DOM.
 *
 * **Schema limitation.** Events carry the acting player's id and position, and nothing
 * about a counterparty. There is no target id, so this module draws points in space and
 * time only — never a link between two actors.
 */

import { EventCode } from '../data/types';

export type EventClass =
  | 'Kill'
  | 'Killed'
  | 'BotKill'
  | 'BotKilled'
  | 'KilledByStorm'
  | 'Loot';

/** Toggle groups presented in the UI. */
export type EventGroup = 'kills' | 'deaths' | 'storm' | 'loot';

export interface EventMarkerSpec {
  code: number;
  label: string;
  /** Longer description used in the legend and tooltip. */
  description: string;
  group: EventGroup;
  shape: ShapeName;
  colour: string;
  /** Marker radius in CSS pixels. */
  radius: number;
  /** `fill` for solid shapes, `stroke` for line shapes. */
  mode: 'fill' | 'stroke';
  /** Alpha applied when the class is drawn in bulk. */
  alpha: number;
  /**
   * Painting order, low to high. Common, low-signal events sit underneath so that rare,
   * design-relevant ones are never buried: loot (thousands) below storm deaths (39).
   */
  z: number;
}

export type ShapeName = 'circle' | 'cross' | 'star' | 'diamond' | 'triangleDown' | 'hexagon';

const TAU = Math.PI * 2;

/** Appends one marker outline to `path`. Pure geometry — no styling. */
export const SHAPES: Record<ShapeName, (path: Path2D, x: number, y: number, r: number) => void> = {
  circle(path, x, y, r) {
    path.moveTo(x + r, y);
    path.arc(x, y, r, 0, TAU);
  },

  /** Diagonal cross. Stroked, so it reads as two strikes rather than a solid blob. */
  cross(path, x, y, r) {
    path.moveTo(x - r, y - r);
    path.lineTo(x + r, y + r);
    path.moveTo(x + r, y - r);
    path.lineTo(x - r, y + r);
  },

  /** Five-point star. Reserved for the rarest event class so it cannot be missed. */
  star(path, x, y, r) {
    const inner = r * 0.45;
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 === 0 ? r : inner;
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    }
    path.closePath();
  },

  diamond(path, x, y, r) {
    path.moveTo(x, y - r);
    path.lineTo(x + r, y);
    path.lineTo(x, y + r);
    path.lineTo(x - r, y);
    path.closePath();
  },

  /** Downward triangle — the actor went down here. */
  triangleDown(path, x, y, r) {
    path.moveTo(x - r, y - r * 0.72);
    path.lineTo(x + r, y - r * 0.72);
    path.lineTo(x, y + r);
    path.closePath();
  },

  hexagon(path, x, y, r) {
    for (let i = 0; i < 6; i++) {
      const angle = -Math.PI / 2 + (i * TAU) / 6;
      const px = x + Math.cos(angle) * r;
      const py = y + Math.sin(angle) * r;
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    }
    path.closePath();
  },
};

/**
 * The event marker registry.
 *
 * Sizes and z-order encode the hierarchy. Loot is the most common event by an order of
 * magnitude and is drawn smallest, faintest and lowest; player-versus-player kills total
 * six rows in the entire dataset and are drawn largest and on top.
 */
export const EVENT_MARKERS: Record<EventClass, EventMarkerSpec> = {
  Loot: {
    code: EventCode.Loot,
    label: 'Loot',
    description: 'Item picked up',
    group: 'loot',
    shape: 'circle',
    colour: '#c9a227',
    radius: 1.9,
    mode: 'fill',
    alpha: 0.55,
    z: 0,
  },
  BotKill: {
    code: EventCode.BotKill,
    label: 'Kill (bot)',
    description: 'Actor killed a bot',
    group: 'kills',
    shape: 'cross',
    colour: '#ff8c42',
    radius: 3,
    mode: 'stroke',
    alpha: 0.85,
    z: 1,
  },
  BotKilled: {
    code: EventCode.BotKilled,
    label: 'Death (by bot)',
    description: 'Actor was killed by a bot',
    group: 'deaths',
    shape: 'diamond',
    colour: '#ff4d5e',
    radius: 3.6,
    mode: 'fill',
    alpha: 0.9,
    z: 2,
  },
  KilledByStorm: {
    code: EventCode.KilledByStorm,
    label: 'Death (storm)',
    description: 'Actor was consumed by the storm',
    group: 'storm',
    shape: 'hexagon',
    colour: '#b06cff',
    radius: 4.6,
    mode: 'stroke',
    alpha: 1,
    z: 3,
  },
  Killed: {
    code: EventCode.Killed,
    label: 'Death (by player)',
    description: 'Actor was killed by another player',
    group: 'deaths',
    shape: 'triangleDown',
    colour: '#ff2d42',
    radius: 5,
    mode: 'fill',
    alpha: 1,
    z: 4,
  },
  Kill: {
    code: EventCode.Kill,
    label: 'Kill (player)',
    description: 'Actor killed another player',
    group: 'kills',
    shape: 'star',
    colour: '#ffd166',
    radius: 5.4,
    mode: 'fill',
    alpha: 1,
    z: 5,
  },
};

/** Painting order, lowest z first. */
export const MARKERS_BY_Z: EventMarkerSpec[] = Object.values(EVENT_MARKERS).sort(
  (a, b) => a.z - b.z,
);

/** Event code -> marker spec, for O(1) lookup in render and hit-test loops. */
export const MARKER_BY_CODE: ReadonlyMap<number, EventMarkerSpec> = new Map(
  Object.values(EVENT_MARKERS).map((spec) => [spec.code, spec]),
);

/** All codes that this layer renders. Movement samples are deliberately absent. */
export const EVENT_CODES: ReadonlySet<number> = new Set(
  Object.values(EVENT_MARKERS).map((spec) => spec.code),
);

export const EVENT_GROUP_LABELS: Record<EventGroup, string> = {
  kills: 'Kills',
  deaths: 'Deaths',
  storm: 'Storm deaths',
  loot: 'Loot',
};

/** Marker classes belonging to each toggle group, in painting order. */
export const GROUP_MEMBERS: Record<EventGroup, EventMarkerSpec[]> = {
  kills: [EVENT_MARKERS.BotKill, EVENT_MARKERS.Kill],
  deaths: [EVENT_MARKERS.BotKilled, EVENT_MARKERS.Killed],
  storm: [EVENT_MARKERS.KilledByStorm],
  loot: [EVENT_MARKERS.Loot],
};
