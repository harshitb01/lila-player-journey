/**
 * Filter evaluation and facet counting.
 *
 * Pure functions over the loaded dataset, kept out of React so the cascade rules are
 * directly testable and computed exactly once per filter change.
 *
 * **Cascade rule.** Each facet's option counts are computed with every *other* filter
 * applied but its own excluded. Applying a facet to itself would drive its own counts to
 * zero and make deselected options impossible to re-select — the classic self-filtering
 * trap. So the date list reflects the current map and actor choice, but not the current
 * date choice.
 */

import type { Dataset, JourneyModel } from '../data/model';
import { EVENT_NAMES, type EventName } from '../data/types';
import type { EventGroup } from '../render/eventMarkers';
import type { MapId } from '../utils/coordinates';

export interface ActorVisibility {
  human: boolean;
  bot: boolean;
}

export interface FilterState {
  mapId: MapId | null;
  /** Empty means "all dates". */
  dates: ReadonlySet<string>;
  actors: ActorVisibility;
  /** Match id, or null for "all matches on this map". */
  match: number | null;
}

export interface DateOption {
  date: string;
  /** Journeys on this date under the current map and actor filters. */
  count: number;
  /** False when the date has nothing to show; the option is offered but disabled. */
  available: boolean;
  selected: boolean;
}

export interface FilterResult {
  /** Journeys passing every active filter, in dataset order. */
  journeyIds: number[];
  /** Distinct matches represented in {@link journeyIds}. */
  matchCount: number;
  /** Telemetry rows represented, from the index — never a scan of point data. */
  pointCount: number;
  eventCounts: Record<EventName, number>;

  /** Matches selectable under the current map, date and actor filters. */
  matchOptions: number[];
  dateOptions: DateOption[];
  /** Actor counts under the current map and date filters, ignoring actor visibility. */
  actorCounts: ActorVisibility extends never ? never : { human: number; bot: number };

  /** True when the selected match still exists in {@link matchOptions}. */
  matchIsValid: boolean;
  /** Paths become unreadable past this many journeys. */
  pathsReadable: boolean;
}

export const PATH_READABILITY_LIMIT = 25;

export const DEFAULT_ACTORS: ActorVisibility = { human: true, bot: true };

export const DEFAULT_EVENT_VISIBILITY: Record<EventGroup, boolean> = {
  kills: false,
  deaths: true,
  storm: true,
  loot: false,
};

/** True when nothing is filtered away and no match is drilled into. */
export function isDefaultFilterState(state: FilterState): boolean {
  return (
    state.dates.size === 0 &&
    state.actors.human &&
    state.actors.bot &&
    state.match === null
  );
}

function emptyEventCounts(): Record<EventName, number> {
  return Object.fromEntries(EVENT_NAMES.map((name) => [name, 0])) as Record<
    EventName,
    number
  >;
}

function passesDate(journey: JourneyModel, dates: ReadonlySet<string>): boolean {
  return dates.size === 0 || dates.has(journey.date);
}

/**
 * Evaluate the filter state against the dataset.
 *
 * Runs over the journey index only — at most 1,242 records — and never touches point
 * data, so it is cheap enough to recompute on every keystroke-level interaction.
 */
export function computeFilters(
  dataset: Dataset | null,
  state: FilterState,
): FilterResult {
  const empty: FilterResult = {
    journeyIds: [],
    matchCount: 0,
    pointCount: 0,
    eventCounts: emptyEventCounts(),
    matchOptions: [],
    dateOptions: [],
    actorCounts: { human: 0, bot: 0 },
    matchIsValid: state.match === null,
    pathsReadable: false,
  };
  if (!dataset || !state.mapId) return empty;

  const candidates = dataset.journeysByMap.get(state.mapId) ?? [];

  const journeyIds: number[] = [];
  const matches = new Set<number>();
  const matchOptionSet = new Set<number>();
  const eventCounts = emptyEventCounts();
  const dateCounts = new Map<string, number>();
  const actorCounts = { human: 0, bot: 0 };
  let pointCount = 0;

  for (const id of candidates) {
    const journey = dataset.journeys[id];
    if (!journey) continue;

    const dateOk = passesDate(journey, state.dates);
    const actorOk = state.actors[journey.actorType];

    // Facet counts: each excludes its own filter so its options stay reachable.
    if (actorOk) {
      dateCounts.set(journey.date, (dateCounts.get(journey.date) ?? 0) + 1);
    }
    if (dateOk) {
      actorCounts[journey.actorType]++;
    }
    // The match list reflects map + date + actor, but not the match drill-down itself.
    if (dateOk && actorOk) {
      matchOptionSet.add(journey.match);
    }

    if (!dateOk || !actorOk) continue;
    if (state.match !== null && journey.match !== state.match) continue;

    journeyIds.push(id);
    matches.add(journey.match);
    for (const name of EVENT_NAMES) {
      const n = journey.eventCounts[name];
      eventCounts[name] += n;
      pointCount += n;
    }
  }

  const dateOptions: DateOption[] = dataset.dates.map((date) => {
    const count = dateCounts.get(date) ?? 0;
    return {
      date,
      count,
      available: count > 0,
      selected: state.dates.size === 0 || state.dates.has(date),
    };
  });

  const matchOptions = [...matchOptionSet].sort((a, b) => {
    const left = dataset.matches[a];
    const right = dataset.matches[b];
    return (right?.startedAt ?? 0) - (left?.startedAt ?? 0);
  });

  return {
    journeyIds,
    matchCount: matches.size,
    pointCount,
    eventCounts,
    matchOptions,
    dateOptions,
    actorCounts,
    matchIsValid: state.match === null || matchOptionSet.has(state.match),
    pathsReadable: journeyIds.length > 0 && journeyIds.length <= PATH_READABILITY_LIMIT,
  };
}

/**
 * Reasons the current filter combination yields nothing.
 *
 * Drives the empty state, which must name the cause and offer the specific relaxation
 * rather than showing a bare "no results".
 */
export interface EmptyReason {
  hiddenActors: ('human' | 'bot')[];
  datesExcludeEverything: boolean;
  matchExcludesEverything: boolean;
}

export function diagnoseEmpty(
  dataset: Dataset | null,
  state: FilterState,
  result: FilterResult,
): EmptyReason {
  const hiddenActors = (['human', 'bot'] as const).filter((a) => !state.actors[a]);

  // Would relaxing only the dates produce anything?
  const withAllDates = dataset
    ? computeFilters(dataset, { ...state, dates: new Set(), match: null })
    : result;
  const withAnyMatch = dataset
    ? computeFilters(dataset, { ...state, match: null })
    : result;

  return {
    hiddenActors,
    datesExcludeEverything:
      state.dates.size > 0 && result.journeyIds.length === 0 && withAllDates.journeyIds.length > 0,
    matchExcludesEverything:
      state.match !== null &&
      result.journeyIds.length === 0 &&
      withAnyMatch.journeyIds.length > 0,
  };
}
