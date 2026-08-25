import { SHAPES, type EventMarkerSpec } from '../render/eventMarkers';

/**
 * Renders an event marker as a small SVG glyph for the legend and toggle rows.
 *
 * Geometry comes from the same {@link SHAPES} table the canvas uses, so a legend entry
 * can never drift from what is actually drawn on the map. The shapes append to a
 * `Path2D` on canvas; here the same functions build an SVG path string through a tiny
 * shim, which keeps a single definition of every outline.
 */
class PathRecorder {
  d = '';
  moveTo(x: number, y: number) {
    this.d += `M${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  lineTo(x: number, y: number) {
    this.d += `L${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  closePath() {
    this.d += 'Z';
  }
  arc(x: number, y: number, r: number) {
    // Two half-arcs describe a full circle in SVG path syntax.
    this.d += `M${(x - r).toFixed(2)} ${y.toFixed(2)}a${r} ${r} 0 1 0 ${(r * 2).toFixed(2)} 0a${r} ${r} 0 1 0 ${(-r * 2).toFixed(2)} 0Z`;
  }
}

export function EventGlyph({
  spec,
  size = 14,
  muted = false,
}: {
  spec: EventMarkerSpec;
  size?: number;
  muted?: boolean;
}) {
  const recorder = new PathRecorder();
  const centre = size / 2;
  // Scale to fit the glyph box, leaving a little breathing room.
  const radius = Math.min(spec.radius, size / 2 - 1.5);
  SHAPES[spec.shape](recorder as unknown as Path2D, centre, centre, radius);

  const colour = muted ? 'currentColor' : spec.colour;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      className="shrink-0 overflow-visible"
    >
      <path
        d={recorder.d}
        fill={spec.mode === 'fill' ? colour : 'none'}
        stroke={colour}
        strokeWidth={spec.mode === 'fill' ? 0.6 : 1.4}
        strokeLinecap="round"
        opacity={muted ? 0.5 : 1}
      />
    </svg>
  );
}
