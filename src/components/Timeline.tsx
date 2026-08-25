import { useEffect, useMemo, useRef } from 'react';

import { formatDuration } from '../analysis/journeyStats';
import { EVENT_CODES, MARKER_BY_CODE } from '../render/eventMarkers';
import { PLAYBACK_SPEEDS } from '../render/playback';
import { useAppState, useDispatch } from '../state/store';

interface Tick {
  key: string;
  tRel: number;
  code: number;
  colour: string;
  label: string;
  fraction: number;
}

/** mm:ss with a fixed width so the readout does not jitter as digits change. */
function TimeReadout({ seconds }: { seconds: number }) {
  return <span className="tabular-nums text-ink-0">{formatDuration(seconds)}</span>;
}

/**
 * Timeline and playback transport.
 *
 * Inert until a match is selected: the aggregate view spans six days of unrelated
 * matches, so a shared playhead across it would be meaningless.
 *
 * The slider is the authority on position. Everything drawn at a given time derives from
 * that value alone, so scrubbing backwards is exactly as valid as playing forwards.
 */
export function Timeline() {
  const { dataset, selectedMatch, mapId, tracks, eventVisibility, focusedJourney, playback } =
    useAppState();
  const dispatch = useDispatch();

  const match = selectedMatch !== null ? dataset?.matches[selectedMatch] : null;
  const mapTracks = mapId ? tracks.get(mapId) : undefined;
  const duration = match?.durationSec ?? 0;

  const ticks = useMemo<Tick[]>(() => {
    if (!match || !mapTracks || match.durationSec <= 0) return [];
    const journeyIds = new Set(match.journeys);
    const out: Tick[] = [];

    for (let i = 0; i < mapTracks.pointCount; i++) {
      const code = mapTracks.eventType[i] ?? -1;
      if (!EVENT_CODES.has(code)) continue;
      const spec = MARKER_BY_CODE.get(code);
      if (!spec || !eventVisibility[spec.group]) continue;

      const slot = mapTracks.journeySlot[i] ?? 0;
      const journeyId = mapTracks.journeyIds[slot];
      if (journeyId === undefined || !journeyIds.has(journeyId)) continue;
      if (focusedJourney !== null && journeyId !== focusedJourney) continue;

      const tRel = mapTracks.tRel[i] ?? 0;
      out.push({
        key: `${i}`,
        tRel,
        code,
        colour: spec.colour,
        label: spec.label,
        fraction: Math.min(1, Math.max(0, tRel / match.durationSec)),
      });
    }
    return out.sort(
      (a, b) => (MARKER_BY_CODE.get(a.code)?.z ?? 0) - (MARKER_BY_CODE.get(b.code)?.z ?? 0),
    );
  }, [match, mapTracks, eventVisibility, focusedJourney]);

  // Space toggles playback, unless the user is typing in a field.
  const hasMatch = match != null;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  useEffect(() => {
    if (!hasMatch) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        dispatchRef.current({ type: 'playback/toggle' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasMatch]);

  if (!match) {
    return (
      <footer className="flex h-16 shrink-0 items-center border-t border-edge bg-surface-1 px-4">
        <p className="text-ink-2">
          <span className="mr-1.5">ⓘ</span>
          Select a match to play it back
        </p>
      </footer>
    );
  }

  const elapsedTicks = ticks.filter((t) => t.tRel <= playback.time).length;
  const progress = duration > 0 ? (playback.time / duration) * 100 : 0;

  return (
    <footer className="flex h-16 shrink-0 flex-col justify-center gap-1 border-t border-edge bg-surface-1 px-4">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => dispatch({ type: 'playback/toggle' })}
          aria-label={playback.playing ? 'Pause' : 'Play'}
          title={`${playback.playing ? 'Pause' : 'Play'} (Space)`}
          className="w-7 rounded border border-edge bg-surface-2 py-0.5 text-ink-0 hover:bg-surface-3"
        >
          {playback.playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'playback/reset' })}
          aria-label="Reset to start"
          title="Reset to start"
          className="w-7 rounded border border-edge bg-surface-2 py-0.5 text-ink-1 hover:bg-surface-3 hover:text-ink-0"
        >
          ⟲
        </button>

        <TimeReadout seconds={playback.time} />

        <div className="relative h-6 flex-1">
          {/* Event ticks sit behind the slider so the thumb never hides them. */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface-3" />
          <div
            className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent/70"
            style={{ width: `${progress}%` }}
          />
          {ticks.map((tick) => (
            <span
              key={tick.key}
              title={`${tick.label} · ${formatDuration(tick.tRel)}`}
              style={{ left: `${tick.fraction * 100}%`, background: tick.colour }}
              className={`pointer-events-none absolute top-1/2 h-3.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity ${
                tick.tRel <= playback.time ? 'opacity-100' : 'opacity-25'
              }`}
            />
          ))}
          <input
            type="range"
            min={0}
            max={duration}
            step={1}
            value={playback.time}
            onChange={(event) =>
              dispatch({
                type: 'playback/seek',
                time: Number(event.target.value),
                duration,
              })
            }
            aria-label="Seek"
            className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent accent-accent"
          />
        </div>

        <span className="tabular-nums text-ink-2">{formatDuration(duration)}</span>

        <div className="flex items-center rounded border border-edge" role="group" aria-label="Speed">
          {PLAYBACK_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              onClick={() => dispatch({ type: 'playback/speed', speed })}
              aria-pressed={playback.speed === speed}
              className={`px-1.5 py-0.5 text-[11px] tabular-nums transition-colors first:rounded-l last:rounded-r ${
                playback.speed === speed
                  ? 'bg-surface-3 text-ink-0'
                  : 'text-ink-2 hover:text-ink-1'
              }`}
            >
              {speed}×
            </button>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-ink-2">
        {match.matchId.replace('.nakama-0', '').slice(0, 8)} ·{' '}
        {new Date(match.startedAt * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC ·{' '}
        {match.journeys.length} journey{match.journeys.length === 1 ? '' : 's'}
        {match.isPartialRoster && ' · roster size unknown'} · {elapsedTicks}/{ticks.length}{' '}
        events elapsed
        {focusedJourney !== null && ' (selected actor only)'}
        <span className="ml-2">ⓘ positions interpolate nothing — samples are ~5s apart</span>
      </p>
    </footer>
  );
}
