import { describe, expect, it } from 'vitest';

import { EventCode } from '../data/types';
import {
  EVENT_CODES,
  EVENT_MARKERS,
  MARKERS_BY_Z,
  MARKER_BY_CODE,
  SHAPES,
  type EventClass,
} from './eventMarkers';

/** Records path commands so geometry can be asserted without a real canvas. */
class RecordingPath {
  commands: string[] = [];
  points: [number, number][] = [];
  moveTo(x: number, y: number) {
    this.commands.push('M');
    this.points.push([x, y]);
  }
  lineTo(x: number, y: number) {
    this.commands.push('L');
    this.points.push([x, y]);
  }
  closePath() {
    this.commands.push('Z');
  }
  arc(x: number, y: number, r: number) {
    this.commands.push('A');
    this.points.push([x, y]);
    void r;
  }
}

const ALL_CLASSES: EventClass[] = [
  'Kill',
  'Killed',
  'BotKill',
  'BotKilled',
  'KilledByStorm',
  'Loot',
];

describe('event marker registry', () => {
  it('covers all six event classes the schema defines', () => {
    expect(Object.keys(EVENT_MARKERS).sort()).toEqual([...ALL_CLASSES].sort());
  });

  it('gives every class a DISTINCT shape, not just a distinct colour', () => {
    const shapes = ALL_CLASSES.map((name) => EVENT_MARKERS[name].shape);
    expect(new Set(shapes).size).toBe(ALL_CLASSES.length);
  });

  it('also gives every class a distinct colour, as a secondary cue', () => {
    const colours = ALL_CLASSES.map((name) => EVENT_MARKERS[name].colour);
    expect(new Set(colours).size).toBe(ALL_CLASSES.length);
  });

  it('maps codes to the matching telemetry event', () => {
    expect(EVENT_MARKERS.Loot.code).toBe(EventCode.Loot);
    expect(EVENT_MARKERS.Kill.code).toBe(EventCode.Kill);
    expect(EVENT_MARKERS.KilledByStorm.code).toBe(EventCode.KilledByStorm);
    expect(MARKER_BY_CODE.get(EventCode.BotKilled)?.label).toBe('Death (by bot)');
  });

  it('excludes movement samples — those are polylines, not markers', () => {
    expect(EVENT_CODES.has(EventCode.Position)).toBe(false);
    expect(EVENT_CODES.has(EventCode.BotPosition)).toBe(false);
    expect(EVENT_CODES.size).toBe(6);
  });
});

describe('visual hierarchy', () => {
  it('orders painting so rare events sit above common ones', () => {
    const order = MARKERS_BY_Z.map((spec) => spec.label);
    expect(order[0]).toBe('Loot'); // ~9,000 per map — painted first, underneath
    expect(order.at(-1)).toBe('Kill (player)'); // 3 rows dataset-wide — painted last
  });

  it('has a strictly increasing z with no ties', () => {
    const zs = MARKERS_BY_Z.map((spec) => spec.z);
    expect(new Set(zs).size).toBe(zs.length);
    expect([...zs].sort((a, b) => a - b)).toEqual(zs);
  });

  it('sizes loot smallest and player kills largest', () => {
    const radii = ALL_CLASSES.map((name) => EVENT_MARKERS[name].radius);
    expect(EVENT_MARKERS.Loot.radius).toBe(Math.min(...radii));
    expect(EVENT_MARKERS.Kill.radius).toBe(Math.max(...radii));
  });

  it('keeps loot faint so it cannot bury the rest of the layer', () => {
    expect(EVENT_MARKERS.Loot.alpha).toBeLessThan(EVENT_MARKERS.Killed.alpha);
  });
});

describe('shape geometry', () => {
  it('builds every shape around the requested centre', () => {
    for (const name of Object.keys(SHAPES) as (keyof typeof SHAPES)[]) {
      const path = new RecordingPath();
      SHAPES[name](path as unknown as Path2D, 50, 40, 6);
      expect(path.commands.length).toBeGreaterThan(0);

      for (const [x, y] of path.points) {
        expect(Math.abs(x - 50)).toBeLessThanOrEqual(6.01);
        expect(Math.abs(y - 40)).toBeLessThanOrEqual(6.01);
      }
    }
  });

  it('closes the filled polygons', () => {
    for (const name of ['star', 'diamond', 'triangleDown', 'hexagon'] as const) {
      const path = new RecordingPath();
      SHAPES[name](path as unknown as Path2D, 0, 0, 5);
      expect(path.commands).toContain('Z');
    }
  });

  it('draws the cross as two disconnected strokes', () => {
    const path = new RecordingPath();
    SHAPES.cross(path as unknown as Path2D, 0, 0, 4);
    // Two moveTo/lineTo pairs: the strokes must not be joined into a V.
    expect(path.commands).toEqual(['M', 'L', 'M', 'L']);
  });

  it('gives the hexagon six corners and the star ten vertices', () => {
    const hex = new RecordingPath();
    SHAPES.hexagon(hex as unknown as Path2D, 0, 0, 5);
    expect(hex.points).toHaveLength(6);

    const star = new RecordingPath();
    SHAPES.star(star as unknown as Path2D, 0, 0, 5);
    expect(star.points).toHaveLength(10);
  });

  it('alternates star radii between outer and inner points', () => {
    const star = new RecordingPath();
    SHAPES.star(star as unknown as Path2D, 0, 0, 10);
    const radii = star.points.map(([x, y]) => Math.hypot(x, y));
    expect(radii[0]).toBeCloseTo(10, 6);
    expect(radii[1]).toBeCloseTo(4.5, 6);
    expect(radii[2]).toBeCloseTo(10, 6);
  });
});

describe('schema honesty', () => {
  it('describes events in terms of the acting player only', () => {
    // No spec may imply a known counterparty identity: the schema has no target id.
    for (const spec of MARKERS_BY_Z) {
      expect(spec.description.toLowerCase()).not.toMatch(/\bvictim\b|\bkiller of\b|\btarget id\b/);
    }
  });
});
