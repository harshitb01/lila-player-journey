import { useState } from 'react';

import { MARKERS_BY_Z } from '../render/eventMarkers';
import { HEATMAP_LABELS, rampSwatches } from '../render/heatmap';
import { useAppState, useSelection } from '../state/store';
import { EventGlyph } from './EventGlyph';

/**
 * Persistent legend for everything the canvas can draw.
 *
 * Event glyphs are generated from the same shape table the renderer uses, so the legend
 * cannot describe a marker that differs from what is painted. Route styles are shown as
 * line samples because dash pattern — not colour — is what separates humans from bots.
 */
export function Legend() {
  const [open, setOpen] = useState(true);
  const { mapId, dataset, eventVisibility, heatmapMode, pathMode } = useAppState();
  const selection = useSelection();
  const map = mapId ? dataset?.mapsById.get(mapId) : null;
  if (!map) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute bottom-4 right-4 z-10 rounded-md border border-edge bg-surface-1/90 px-2 py-1 text-ink-2 hover:text-ink-0"
        aria-label="Show legend"
      >
        ⓘ
      </button>
    );
  }

  // Highest-signal classes first, so the legend reads in the same order as the map's
  // visual hierarchy rather than in data order.
  const visibleMarkers = MARKERS_BY_Z.filter((spec) => eventVisibility[spec.group]).reverse();

  return (
    <div className="absolute bottom-4 right-4 z-10 w-60 rounded-md border border-edge bg-surface-1/92 p-3 backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-2">
          Legend
        </h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-ink-2 hover:text-ink-0"
          aria-label="Hide legend"
        >
          ×
        </button>
      </div>

      {heatmapMode !== 'none' && (
        <>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-2">
            {HEATMAP_LABELS[heatmapMode]}
          </p>
          <div className="mb-1 flex h-2.5 overflow-hidden rounded-sm">
            {rampSwatches(heatmapMode, 14).map((s, i) => (
              <span key={i} className="flex-1" style={{ background: s.css }} />
            ))}
          </div>
          {/*
            The ramp is normalised to whatever is currently filtered, so the same colour
            means different absolute counts in different selections. Saying so on the
            axis keeps the caveat where it is read, instead of in a paragraph below.
          */}
          <div className="mb-1 flex justify-between text-[10px] text-ink-2">
            {heatmapMode === 'lowActivity' ? (
              <>
                <span>more activity</span>
                <span>less activity</span>
              </>
            ) : (
              <>
                <span>fewer</span>
                <span>more {heatmapMode === 'traffic' ? 'samples' : 'events'}</span>
              </>
            )}
          </div>
          <p className="mb-3 text-[10px] text-ink-2">relative to current filter</p>
        </>
      )}

      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-2">
        Routes
      </p>
      <p className="mb-2 text-[10px] text-ink-2">
        {pathMode === 'auto'
          ? `Auto — cohort routes ${selection.pathsReadable ? 'shown' : 'hidden'}`
          : pathMode === 'on'
            ? 'Cohort routes shown'
            : 'Cohort routes hidden'}
      </p>
      <ul className="space-y-1.5">
        <li className="flex items-center gap-2">
          <svg width="26" height="8" aria-hidden className="shrink-0">
            <line x1="0" y1="4" x2="26" y2="4" stroke="#dbe6f5" strokeWidth="1.6" />
          </svg>
          <span className="text-ink-1">human — solid</span>
        </li>
        <li className="flex items-center gap-2">
          <svg width="26" height="8" aria-hidden className="shrink-0">
            <line
              x1="0"
              y1="4"
              x2="26"
              y2="4"
              stroke="#8b98ad"
              strokeWidth="1.2"
              strokeDasharray="2.5 3"
            />
          </svg>
          <span className="text-ink-1">bot — dashed</span>
        </li>
        <li className="flex items-center gap-2">
          <svg width="26" height="8" aria-hidden className="shrink-0">
            <line
              x1="0"
              y1="4"
              x2="26"
              y2="4"
              stroke="rgba(190,205,225,0.7)"
              strokeWidth="1.2"
              strokeDasharray="1 4"
            />
          </svg>
          <span className="text-ink-1">gap — route unknown</span>
        </li>
        {selection.pathsReadable && (
          <li className="flex items-center gap-2">
            <svg width="26" height="10" aria-hidden className="shrink-0">
              <circle cx="5" cy="5" r="3.5" fill="#0b0d10" stroke="#4da3ff" strokeWidth="1.6" />
              <rect x="17" y="2" width="6" height="6" fill="#4da3ff" />
            </svg>
            <span className="text-ink-1">first / last position</span>
          </li>
        )}
      </ul>

      {visibleMarkers.length > 0 && (
        <>
          <p className="mb-1.5 mt-3 text-[10px] font-semibold uppercase tracking-wider text-ink-2">
            Events
          </p>
          <ul className="space-y-1.5">
            {visibleMarkers.map((spec) => (
              <li key={spec.label} className="flex items-center gap-2">
                <span className="flex w-[26px] justify-center">
                  <EventGlyph spec={spec} size={14} />
                </span>
                <span className="text-ink-1">{spec.label}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/*
        One line, not a paragraph. The sampling caveat is already stated permanently on
        the timeline, and the schema's missing target id on every combat tooltip — the
        legend only needs to key what is drawn, plus the one interaction that has no
        other affordance on the map.
      */}
      <p className="mt-2.5 border-t border-edge pt-2 text-[11px] text-ink-2">
        <kbd className="rounded border border-edge bg-surface-2 px-1 font-sans">Shift</kbd>
        {' '}+ drag to measure a region
      </p>
    </div>
  );
}
