/**
 * Loading, empty and error states.
 *
 * Every one of these names the cause and, where possible, offers the fix. See
 * UX_SPEC.md §§11–13.
 */

import { useAppState, useDispatch, useSelection } from '../state/store';

export function AppLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface-0">
      <div className="flex flex-col items-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-edge border-t-accent" />
        <p className="text-ink-2">Loading telemetry index…</p>
      </div>
    </div>
  );
}

/**
 * Fatal error. Reserved for cases where continuing would show a plausible but wrong
 * picture — a schema mismatch, or missing data entirely.
 */
export function FatalError({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface-0 p-8">
      <div className="max-w-lg rounded-lg border border-edge bg-surface-1 p-6">
        <h1 className="mb-2 text-base font-semibold text-ink-0">{message}</h1>
        {detail && (
          <p className="mb-4 font-mono text-[12px] leading-relaxed text-ink-1">{detail}</p>
        )}
        <p className="text-ink-2">
          The tool will not render against an unexpected data contract, because doing so
          could place points in the wrong location while looking entirely plausible.
        </p>
      </div>
    </div>
  );
}

/** Non-fatal: the map's telemetry failed, everything else stays usable. */
export function TracksError() {
  const { tracksError, mapId } = useAppState();
  const dispatch = useDispatch();
  if (!tracksError || !mapId) return null;

  return (
    <div className="pointer-events-auto absolute left-1/2 top-6 z-20 w-[min(28rem,90%)] -translate-x-1/2 rounded-md border border-[#5a2a2f] bg-[#241417] p-4 shadow-lg">
      <p className="mb-1 font-medium text-[#ff9aa4]">{tracksError.message}</p>
      {tracksError.detail && (
        <p className="mb-3 font-mono text-[11px] text-ink-2">{tracksError.detail}</p>
      )}
      <button
        type="button"
        onClick={() => dispatch({ type: 'map/select', mapId })}
        className="rounded border border-edge bg-surface-2 px-3 py-1 text-ink-0 hover:bg-surface-3"
      >
        Retry
      </button>
    </div>
  );
}

/** Artwork failed but positions are still correct — say so explicitly. */
export function MapArtworkWarning() {
  return (
    <div className="pointer-events-none absolute left-1/2 top-6 z-10 -translate-x-1/2 rounded-md border border-[#5a4a24] bg-[#241f14] px-3 py-2">
      <p className="text-[#e8c46a]">
        Minimap artwork unavailable — positions are still accurate.
      </p>
    </div>
  );
}

export function TracksLoading({ mapName, journeys }: { mapName: string; journeys: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="flex items-center gap-3 rounded-md border border-edge bg-surface-1/90 px-4 py-2.5">
        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-edge border-t-accent" />
        <p className="text-ink-1">
          Loading {journeys.toLocaleString()} journeys
          {mapName ? ` for ${mapName}` : ''}…
        </p>
      </div>
    </div>
  );
}

/**
 * No journeys match.
 *
 * Names the specific cause and offers the exact relaxation. Every branch here is
 * reachable with the real dataset — e.g. Grand Rift on 9 Feb, a date whose only match is
 * on Ambrose Valley.
 */
export function EmptySelection() {
  const { dataset, mapId, selectedDates, actorVisibility, selectedMatch } = useAppState();
  const dispatch = useDispatch();
  const selection = useSelection();
  const map = mapId ? dataset?.mapsById.get(mapId) : null;

  const hiddenActors = (['human', 'bot'] as const).filter((a) => !actorVisibility[a]);
  const bothHidden = hiddenActors.length === 2;
  const datesActive = selectedDates.size > 0;

  // Order the explanation by what most likely caused the emptiness.
  let cause: string;
  if (bothHidden) {
    cause = 'Both humans and bots are hidden.';
  } else if (selectedMatch !== null) {
    cause = 'The selected match has nothing left after the other filters.';
  } else if (datesActive && hiddenActors.length === 1) {
    cause = `No ${hiddenActors[0] === 'human' ? 'bot' : 'human'} journeys on the selected date${
      selectedDates.size === 1 ? '' : 's'
    }.`;
  } else if (datesActive) {
    cause =
      selectedDates.size === 1
        ? `No journeys on ${[...selectedDates][0]}.`
        : `No journeys on the ${selectedDates.size} selected dates.`;
  } else if (hiddenActors.length === 1) {
    cause = `No ${hiddenActors[0] === 'human' ? 'bot' : 'human'} journeys on this map.`;
  } else {
    cause = 'No journeys recorded.';
  }

  const availableDates = selection.dateOptions.filter((o) => o.available);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="pointer-events-auto max-w-sm rounded-lg border border-edge bg-surface-1/95 p-5 text-center">
        <p className="mb-1 font-medium text-ink-0">No journeys match these filters.</p>
        <p className="mb-1.5 text-ink-1">{cause}</p>
        <p className="mb-4 text-[11px] text-ink-2">
          {map
            ? `${map.displayName} has ${map.totals.journeys.toLocaleString()} journeys in total`
            : ''}
          {datesActive && availableDates.length > 0
            ? ` · ${availableDates.length} date${
                availableDates.length === 1 ? '' : 's'
              } have data here`
            : ''}
          .
        </p>

        <div className="flex flex-wrap justify-center gap-2">
          {hiddenActors.map((actor) => (
            <button
              key={actor}
              type="button"
              onClick={() => dispatch({ type: 'actor/toggle', actor })}
              className="rounded border border-edge bg-surface-2 px-3 py-1 text-ink-0 hover:bg-surface-3"
            >
              Show {actor}s
            </button>
          ))}
          {selectedMatch !== null && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'match/select', match: null })}
              className="rounded border border-edge bg-surface-2 px-3 py-1 text-ink-0 hover:bg-surface-3"
            >
              All matches
            </button>
          )}
          {datesActive && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'dates/clear' })}
              className="rounded border border-edge bg-surface-2 px-3 py-1 text-ink-0 hover:bg-surface-3"
            >
              Show all dates
            </button>
          )}
          <button
            type="button"
            onClick={() => dispatch({ type: 'filters/reset' })}
            className="rounded border border-edge bg-surface-2 px-3 py-1 text-ink-1 hover:bg-surface-3 hover:text-ink-0"
          >
            Reset filters
          </button>
        </div>
      </div>
    </div>
  );
}
