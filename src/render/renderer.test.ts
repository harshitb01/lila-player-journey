import { beforeAll, describe, expect, it } from 'vitest';

import type { MapTracks } from '../data/model';
import { EventCode } from '../data/types';
import { PATH_STYLE, drawJourneys, pickJourney, type RenderOptions } from './renderer';
import type { Rect } from './viewport';

/** Records the segments added to it so the test can assert on path geometry. */
class FakePath2D {
  segments: { from: [number, number]; to: [number, number] }[] = [];
  private cursor: [number, number] = [0, 0];
  moveTo(x: number, y: number) {
    this.cursor = [x, y];
  }
  lineTo(x: number, y: number) {
    this.segments.push({ from: this.cursor, to: [x, y] });
    this.cursor = [x, y];
  }
}

interface StrokeCall {
  strokeStyle: string;
  lineWidth: number;
  dash: number[];
  alpha: number;
  segmentCount: number;
}

/** Minimal 2D context that records the drawing state at each stroke. */
class FakeContext {
  strokeStyle = '';
  fillStyle = '';
  lineWidth = 1;
  globalAlpha = 1;
  lineCap = '';
  lineJoin = '';
  private dash: number[] = [];
  private stack: { strokeStyle: string; lineWidth: number; alpha: number; dash: number[] }[] = [];

  strokes: StrokeCall[] = [];
  arcs: { x: number; y: number; r: number }[] = [];
  rects: { x: number; y: number; w: number; h: number }[] = [];

  save() {
    this.stack.push({
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      alpha: this.globalAlpha,
      dash: this.dash,
    });
  }
  restore() {
    const previous = this.stack.pop();
    if (!previous) return;
    this.strokeStyle = previous.strokeStyle;
    this.lineWidth = previous.lineWidth;
    this.globalAlpha = previous.alpha;
    this.dash = previous.dash;
  }
  setLineDash(dash: number[]) {
    this.dash = dash;
  }
  beginPath() {}
  arc(x: number, y: number, r: number) {
    this.arcs.push({ x, y, r });
  }
  fill() {}
  fillRect(x: number, y: number, w: number, h: number) {
    this.rects.push({ x, y, w, h });
  }
  stroke(path?: FakePath2D) {
    if (!path) return; // the sparse-marker arcs stroke without a Path2D
    this.strokes.push({
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      dash: [...this.dash],
      alpha: this.globalAlpha,
      segmentCount: path.segments.length,
    });
  }
}

beforeAll(() => {
  (globalThis as Record<string, unknown>).Path2D = FakePath2D;
});

const RECT: Rect = { x: 0, y: 0, width: 100, height: 100 };
const P = EventCode.Position;
const B = EventCode.BotPosition;

/** Builds tracks with one journey per `journeys` entry. */
function makeTracks(journeys: { t: number; e: number }[][]): MapTracks {
  const offsets: number[] = [0];
  const tRel: number[] = [];
  const eventType: number[] = [];
  const journeySlot: number[] = [];
  const u: number[] = [];
  const v: number[] = [];

  journeys.forEach((points, slot) => {
    points.forEach((p, i) => {
      tRel.push(p.t);
      eventType.push(p.e);
      journeySlot.push(slot);
      u.push(0.1 + i * 0.05);
      v.push(0.2 + slot * 0.1);
    });
    offsets.push(tRel.length);
  });

  const n = tRel.length;
  return {
    mapId: 'AmbroseValley',
    journeyCount: journeys.length,
    pointCount: n,
    journeyIds: Int32Array.from(journeys.map((_, i) => i)),
    offsets: Uint32Array.from(offsets),
    worldX: new Float32Array(n),
    worldZ: new Float32Array(n),
    u: Float32Array.from(u),
    v: Float32Array.from(v),
    tRel: Uint16Array.from(tRel),
    eventType: Uint8Array.from(eventType),
    journeySlot: Uint32Array.from(journeySlot),
  };
}

function options(tracks: MapTracks, overrides: Partial<RenderOptions> = {}): RenderOptions {
  return {
    rect: RECT,
    tracks,
    visibleSlots: null,
    slotIsBot: null,
    selectedSlot: -1,
    soloThreshold: 25,
    eventGroups: { kills: true, deaths: true, storm: true, loot: true },
    playbackTime: null,
    heatmap: null,
    region: null,
    ...overrides,
  };
}

function run(tracks: MapTracks, overrides: Partial<RenderOptions> = {}) {
  const ctx = new FakeContext();
  drawJourneys(ctx as unknown as CanvasRenderingContext2D, options(tracks, overrides));
  return ctx;
}

describe('actor differentiation', () => {
  const tracks = makeTracks([
    [
      { t: 0, e: P },
      { t: 5, e: P },
      { t: 10, e: P },
    ],
    [
      { t: 0, e: B },
      { t: 5, e: B },
      { t: 10, e: B },
    ],
  ]);
  const slotIsBot = Uint8Array.from([0, 1]);

  it('distinguishes humans and bots by line dash, not colour alone', () => {
    const ctx = run(tracks, { slotIsBot });
    const drawn = ctx.strokes.filter((s) => s.segmentCount > 0);

    const human = drawn.find((s) => s.strokeStyle === PATH_STYLE.human.stroke);
    const bot = drawn.find((s) => s.strokeStyle === PATH_STYLE.bot.stroke);

    expect(human).toBeDefined();
    expect(bot).toBeDefined();
    // The load-bearing assertion: the dash patterns differ.
    expect(human!.dash).toEqual([]);
    expect(bot!.dash).toEqual(PATH_STYLE.bot.dash);
    expect(human!.dash).not.toEqual(bot!.dash);
  });

  it('also differentiates by line weight, so the cue survives greyscale', () => {
    const ctx = run(tracks, { slotIsBot });
    const drawn = ctx.strokes.filter((s) => s.segmentCount > 0);
    const human = drawn.find((s) => s.strokeStyle === PATH_STYLE.human.stroke)!;
    const bot = drawn.find((s) => s.strokeStyle === PATH_STYLE.bot.stroke)!;
    expect(human.lineWidth).toBeGreaterThan(bot.lineWidth);
  });

  it('draws each cohort in a single stroke rather than one per journey', () => {
    const many = makeTracks(
      Array.from({ length: 50 }, () => [
        { t: 0, e: P },
        { t: 5, e: P },
      ]),
    );
    const ctx = run(many);
    const humanStrokes = ctx.strokes.filter(
      (s) => s.strokeStyle === PATH_STYLE.human.stroke && s.segmentCount > 0,
    );
    expect(humanStrokes).toHaveLength(1);
    expect(humanStrokes[0]!.segmentCount).toBe(50);
  });
});

describe('sparse and incomplete journeys', () => {
  it('breaks the polyline at a long gap and draws it in the gap style', () => {
    const tracks = makeTracks([
      [
        { t: 0, e: P },
        { t: 5, e: P }, // normal
        { t: 400, e: P }, // 395 s gap
        { t: 405, e: P }, // normal
      ],
    ]);
    const ctx = run(tracks);
    const solid = ctx.strokes.find(
      (s) => s.strokeStyle === PATH_STYLE.human.stroke && s.segmentCount > 0,
    );
    const gap = ctx.strokes.find(
      (s) => s.strokeStyle === PATH_STYLE.gap.stroke && s.segmentCount > 0,
    );
    expect(solid!.segmentCount).toBe(2);
    expect(gap!.segmentCount).toBe(1);
    expect(gap!.dash).toEqual(PATH_STYLE.gap.dash);
  });

  it('still draws a single-sample journey — absence of a route is not absence of a player', () => {
    const tracks = makeTracks([[{ t: 0, e: P }]]);
    const ctx = run(tracks);
    // No polyline is possible, but the actor is marked at its one known position.
    expect(ctx.strokes.every((s) => s.segmentCount === 0)).toBe(true);
    expect(ctx.arcs).toHaveLength(1);
  });

  it('ignores non-movement events when building the polyline', () => {
    const tracks = makeTracks([
      [
        { t: 0, e: P },
        { t: 2, e: EventCode.Loot },
        { t: 5, e: P },
      ],
    ]);
    const ctx = run(tracks);
    const solid = ctx.strokes.find(
      (s) => s.strokeStyle === PATH_STYLE.human.stroke && s.segmentCount > 0,
    );
    expect(solid!.segmentCount).toBe(1);
  });
});

describe('selection', () => {
  const tracks = makeTracks([
    [
      { t: 0, e: P },
      { t: 5, e: P },
    ],
    [
      { t: 0, e: P },
      { t: 5, e: P },
    ],
  ]);

  it('draws the selected journey with a halo and endpoint markers', () => {
    const ctx = run(tracks, { selectedSlot: 0 });
    const halo = ctx.strokes.find((s) => s.strokeStyle === PATH_STYLE.selected.haloStroke);
    const selected = ctx.strokes.find((s) => s.strokeStyle === PATH_STYLE.selected.stroke);
    expect(halo).toBeDefined();
    expect(selected).toBeDefined();
    expect(halo!.lineWidth).toBeGreaterThan(selected!.lineWidth);
    expect(ctx.arcs.length).toBeGreaterThan(0); // start marker
    expect(ctx.rects.length).toBeGreaterThan(0); // end marker
  });

  it('subdues unselected journeys when a selection exists', () => {
    const withSelection = run(tracks, { selectedSlot: 0 });
    const without = run(tracks);
    const alphaOf = (ctx: FakeContext) =>
      ctx.strokes.find((s) => s.strokeStyle === PATH_STYLE.human.stroke && s.segmentCount > 0)!
        .alpha;
    expect(alphaOf(withSelection)).toBeLessThan(alphaOf(without));
  });

  it('respects visibleSlots', () => {
    const ctx = run(tracks, { visibleSlots: Uint8Array.from([1, 0]) });
    const solid = ctx.strokes.find(
      (s) => s.strokeStyle === PATH_STYLE.human.stroke && s.segmentCount > 0,
    );
    expect(solid!.segmentCount).toBe(1); // only the visible journey
  });
});

describe('pickJourney', () => {
  const tracks = makeTracks([
    [
      { t: 0, e: P },
      { t: 5, e: P },
    ],
    [
      { t: 0, e: P },
      { t: 5, e: P },
    ],
  ]);

  it('returns the slot whose sample is nearest the pointer', () => {
    // slot 0 sits at v = 0.2 -> y = 80; slot 1 at v = 0.3 -> y = 70.
    expect(pickJourney(tracks, RECT, null, { x: 10, y: 80 })).toBe(0);
    expect(pickJourney(tracks, RECT, null, { x: 10, y: 70 })).toBe(1);
  });

  it('returns -1 when nothing is within the threshold', () => {
    expect(pickJourney(tracks, RECT, null, { x: 99, y: 5 })).toBe(-1);
  });

  it('never picks a hidden journey', () => {
    const visible = Uint8Array.from([0, 1]);
    // Nearer to slot 0 (y = 80) than slot 1 (y = 70), but slot 0 is hidden.
    expect(pickJourney(tracks, RECT, visible, { x: 10, y: 76 })).toBe(1);
  });

  it('excludes a candidate sitting exactly on the threshold', () => {
    // slot 1 sits 10px away; the threshold is exclusive, so 10 is out and 11 is in.
    expect(pickJourney(tracks, RECT, Uint8Array.from([0, 1]), { x: 10, y: 80 }, 10)).toBe(-1);
    expect(pickJourney(tracks, RECT, Uint8Array.from([0, 1]), { x: 10, y: 80 }, 11)).toBe(1);
  });
});
