import { useState } from 'react';

import {
  useAppState,
  useDispatch,
  useFiltersAreDefault,
  useSelection,
  type ActorVisibility,
} from '../state/store';
import type { MapId } from '../utils/coordinates';

/** Map tabs live inline, never in a dropdown: only 3 values, and it is the top choice. */
function MapTabs() {
  const { dataset, mapId } = useAppState();
  const dispatch = useDispatch();
  if (!dataset) return null;

  return (
    <nav className="flex items-center gap-0.5" aria-label="Map">
      {dataset.maps.map((map) => {
        const active = map.id === mapId;
        return (
          <button
            key={map.id}
            type="button"
            onClick={() => dispatch({ type: 'map/select', mapId: map.id as MapId })}
            title={`${map.totals.journeys.toLocaleString()} journeys · ${map.totals.matches.toLocaleString()} matches`}
            className={`rounded px-2.5 py-1 transition-colors ${
              active
                ? 'bg-surface-3 text-ink-0'
                : 'text-ink-2 hover:bg-surface-2 hover:text-ink-1'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            {map.displayName}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Date filter, cascaded against the current map and actor selection.
 *
 * Option counts come from the facet computation, which excludes the date filter itself —
 * otherwise deselecting a date would zero its own count and make it unreachable. Dates
 * with nothing to show on the current map are offered but disabled, so the designer can
 * see that the date exists in the dataset and simply has no data here.
 */
function DateFilter() {
  const { dataset, selectedDates } = useAppState();
  const dispatch = useDispatch();
  const selection = useSelection();
  const [open, setOpen] = useState(false);
  if (!dataset) return null;

  const options = selection.dateOptions;
  const availableCount = options.filter((o) => o.available).length;
  const label =
    selectedDates.size === 0
      ? `${dataset.dates[0]?.slice(5)} – ${dataset.dates.at(-1)?.slice(5)}`
      : `${selectedDates.size} date${selectedDates.size === 1 ? '' : 's'}`;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`rounded px-2.5 py-1 hover:bg-surface-2 hover:text-ink-0 ${
          selectedDates.size > 0 ? 'bg-surface-3 text-ink-0' : 'text-ink-1'
        }`}
        aria-expanded={open}
      >
        {label} <span className="text-ink-2">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-edge bg-surface-2 p-1 shadow-xl">
            {options.map((option) => (
              <label
                key={option.date}
                className={`flex items-center gap-2 rounded px-2 py-1.5 ${
                  option.available
                    ? 'cursor-pointer hover:bg-surface-3'
                    : 'cursor-not-allowed opacity-40'
                }`}
                title={option.available ? undefined : 'No journeys on this map for this date'}
              >
                <input
                  type="checkbox"
                  checked={option.selected}
                  disabled={!option.available}
                  onChange={() => dispatch({ type: 'dates/toggle', date: option.date })}
                  className="accent-accent"
                />
                <span className="flex-1 text-ink-1">{option.date}</span>
                <span className="tabular-nums text-ink-2">
                  {option.count.toLocaleString()}
                </span>
              </label>
            ))}
            <p className="border-t border-edge px-2 pb-1 pt-1.5 text-[11px] text-ink-2">
              {availableCount} of {options.length} dates have data on this map.
            </p>
            {selectedDates.size > 0 && (
              <button
                type="button"
                onClick={() => dispatch({ type: 'dates/clear' })}
                className="w-full rounded px-2 py-1.5 text-left text-ink-2 hover:bg-surface-3 hover:text-ink-1"
              >
                Clear — show all dates
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Independent human / bot visibility.
 *
 * Two toggles rather than a three-way filter, and each carries the same shape cue used
 * on the map — a filled dot for humans, a dashed ring for bots — so the legend, the
 * inspector and the canvas all agree without relying on colour.
 */
function ActorToggles() {
  const { actorVisibility } = useAppState();
  const dispatch = useDispatch();
  // Counts cascade with map and date, but not with actor visibility itself.
  const totals = useSelection().actorCounts;

  const options: { key: keyof ActorVisibility; label: string }[] = [
    { key: 'human', label: 'Humans' },
    { key: 'bot', label: 'Bots' },
  ];

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Actor visibility">
      {options.map(({ key, label }) => {
        const on = actorVisibility[key];
        return (
          <button
            key={key}
            type="button"
            onClick={() => dispatch({ type: 'actor/toggle', actor: key })}
            aria-pressed={on}
            title={`${totals[key].toLocaleString()} journeys under the current map and date`}
            className={`flex items-center gap-1.5 rounded border px-2 py-1 transition-colors ${
              on
                ? 'border-edge bg-surface-3 text-ink-0'
                : 'border-transparent text-ink-2 hover:text-ink-1'
            }`}
          >
            <span
              aria-hidden
              className={`inline-block h-2 w-2 rounded-full ${
                key === 'bot'
                  ? `border border-dashed ${on ? 'border-[#8b98ad]' : 'border-ink-2'}`
                  : on
                    ? 'bg-[#dbe6f5]'
                    : 'bg-ink-2'
              }`}
            />
            {label}
            <span className="tabular-nums text-ink-2">{totals[key].toLocaleString()}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Opens the data-quality disclosure. A designer acting on a number deserves the caveats. */
function DataQualityChip({ onOpen }: { onOpen: () => void }) {
  const { dataset } = useAppState();
  if (!dataset || dataset.dataQuality.length === 0) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded border border-[#5a4a24] bg-[#221d13] px-2.5 py-1 text-[#e8c46a] hover:bg-[#2b2417]"
    >
      ⚠ {dataset.dataQuality.length} notes
    </button>
  );
}

/** Clears every data filter. Map choice and event-layer visibility are preserved. */
function ResetFilters() {
  const dispatch = useDispatch();
  const isDefault = useFiltersAreDefault();
  if (isDefault) return null;

  return (
    <button
      type="button"
      onClick={() => dispatch({ type: 'filters/reset' })}
      title="Clear date, actor and match filters"
      className="rounded border border-edge px-2.5 py-1 text-ink-1 hover:bg-surface-2 hover:text-ink-0"
    >
      Reset filters
    </button>
  );
}

export function Header({ onOpenDataQuality }: { onOpenDataQuality: () => void }) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-surface-1 px-3">
      <span className="select-none font-semibold tracking-wide text-ink-0">LILA</span>
      <span className="text-edge">▏</span>
      <MapTabs />
      <span className="text-edge">▏</span>
      <DateFilter />
      <span className="text-edge">▏</span>
      <ActorToggles />
      <div className="flex-1" />
      <ResetFilters />
      <DataQualityChip onOpen={onOpenDataQuality} />
    </header>
  );
}
