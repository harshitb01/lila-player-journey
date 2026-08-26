/**
 * Application state.
 *
 * A `useReducer` behind a context is sufficient here and is deliberately not a store
 * library. The whole state is one dataset, four filter values, a selection and a cache
 * of decoded track data — there are no cross-cutting subscriptions, no server sync and
 * no derived-state fan-out that would justify the extra dependency. Bulk point data
 * lives in typed arrays held by reference, so it never participates in reducer equality
 * checks.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from 'react';

import { DataLoadError, loadDataset, loadMapTracks } from '../data/loader';
import type { Dataset, MapTracks } from '../data/model';
import type { EventGroup } from '../render/eventMarkers';
import type { HeatmapMode } from '../render/heatmap';
import type { UvRect } from '../render/region';
import { clampTime, type PlaybackSpeed } from '../render/playback';
import type { MapId } from '../utils/coordinates';
import {
  DEFAULT_ACTORS,
  DEFAULT_EVENT_VISIBILITY,
  PATH_READABILITY_LIMIT,
  computeFilters,
  isDefaultFilterState,
  type ActorVisibility,
  type FilterResult,
  type FilterState,
} from './filtering';

export { PATH_READABILITY_LIMIT, type ActorVisibility };

/**
 * Which discrete-event groups are drawn.
 *
 * Loot is off by default: at ~9,000 markers on Ambrose Valley it swamps everything else.
 */
export type EventVisibility = Record<EventGroup, boolean>;

/**
 * Playback is a property of the selected match.
 *
 * `time` is match-relative seconds and is the single source of truth for what is drawn:
 * the frame at a given time never depends on how playback reached it.
 */
export interface PlaybackState {
  time: number;
  playing: boolean;
  speed: PlaybackSpeed;
}

export const INITIAL_PLAYBACK: PlaybackState = { time: 0, playing: false, speed: 1 };

export interface LoadError {
  message: string;
  detail?: string;
  /** Schema errors are fatal: rendering a mismatched contract could show wrong data. */
  fatal: boolean;
}

export interface AppState {
  status: 'loading' | 'ready' | 'error';
  dataset: Dataset | null;
  error: LoadError | null;

  mapId: MapId | null;
  /** Empty set means "all dates". */
  selectedDates: ReadonlySet<string>;
  actorVisibility: ActorVisibility;
  eventVisibility: EventVisibility;
  heatmapMode: HeatmapMode;
  /** Multiplies overlay opacity, 0.3..2. */
  heatmapIntensity: number;
  /** Shift+drag region selection, in UV space. Independent of match/journey selection. */
  region: UvRect | null;
  selectedMatch: number | null;
  focusedJourney: number | null;
  playback: PlaybackState;

  tracks: ReadonlyMap<MapId, MapTracks>;
  tracksLoading: MapId | null;
  tracksError: LoadError | null;
}

export type Action =
  | { type: 'dataset/loading' }
  | { type: 'dataset/loaded'; dataset: Dataset }
  | { type: 'dataset/failed'; error: LoadError }
  | { type: 'map/select'; mapId: MapId }
  | { type: 'dates/toggle'; date: string }
  | { type: 'dates/clear' }
  | { type: 'actor/toggle'; actor: keyof ActorVisibility }
  | { type: 'events/toggle'; group: EventGroup }
  | { type: 'heatmap/mode'; mode: HeatmapMode }
  | { type: 'heatmap/intensity'; intensity: number }
  | { type: 'region/set'; region: UvRect }
  | { type: 'region/clear' }
  | { type: 'playback/toggle' }
  | { type: 'playback/pause' }
  | { type: 'playback/seek'; time: number; duration: number }
  | { type: 'playback/tick'; time: number; ended: boolean }
  | { type: 'playback/reset' }
  | { type: 'playback/speed'; speed: PlaybackSpeed }
  | { type: 'filters/reset' }
  | { type: 'filters/reconcile'; match?: number | null; journey?: number | null }
  | { type: 'match/select'; match: number | null }
  | { type: 'journey/focus'; journey: number | null }
  | { type: 'tracks/loading'; mapId: MapId }
  | { type: 'tracks/loaded'; mapId: MapId; tracks: MapTracks }
  | { type: 'tracks/failed'; error: LoadError };

export const initialState: AppState = {
  status: 'loading',
  dataset: null,
  error: null,
  mapId: null,
  selectedDates: new Set(),
  actorVisibility: DEFAULT_ACTORS,
  eventVisibility: DEFAULT_EVENT_VISIBILITY,
  heatmapMode: 'traffic',
  heatmapIntensity: 1,
  region: null,
  selectedMatch: null,
  focusedJourney: null,
  playback: INITIAL_PLAYBACK,
  tracks: new Map(),
  tracksLoading: null,
  tracksError: null,
};

/** The map shown on first load: the one with the most telemetry. */
function defaultMapId(dataset: Dataset): MapId | null {
  let best: MapId | null = null;
  let bestRows = -1;
  for (const map of dataset.maps) {
    if (map.totals.rows > bestRows) {
      bestRows = map.totals.rows;
      best = map.id;
    }
  }
  return best;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'dataset/loading':
      return { ...state, status: 'loading', error: null };

    case 'dataset/loaded':
      return {
        ...state,
        status: 'ready',
        dataset: action.dataset,
        error: null,
        mapId: defaultMapId(action.dataset),
      };

    case 'dataset/failed':
      return { ...state, status: 'error', error: action.error };

    case 'map/select':
      if (state.mapId === action.mapId) return state;
      // Match selection is map-scoped; date and actor filters deliberately persist.
      return {
        ...state,
        mapId: action.mapId,
        selectedMatch: null,
        focusedJourney: null,
        region: null,
        playback: { ...INITIAL_PLAYBACK, speed: state.playback.speed },
        tracksError: null,
      };

    // Filter changes deliberately do NOT clear the selection here. Whether a selection
    // survives depends on whether it still passes the new filters, which the reducer
    // cannot know. Reconciliation happens once, centrally, in `filters/reconcile`.
    case 'dates/toggle': {
      const next = new Set(state.selectedDates);
      if (next.has(action.date)) next.delete(action.date);
      // Selecting into an empty set means "only this date", not "all plus this one".
      else if (state.selectedDates.size === 0) {
        return { ...state, selectedDates: new Set([action.date]) };
      } else next.add(action.date);
      return { ...state, selectedDates: next };
    }

    case 'dates/clear':
      return { ...state, selectedDates: new Set() };

    case 'actor/toggle':
      return {
        ...state,
        actorVisibility: {
          ...state.actorVisibility,
          [action.actor]: !state.actorVisibility[action.actor],
        },
      };

    case 'events/toggle':
      return {
        ...state,
        eventVisibility: {
          ...state.eventVisibility,
          [action.group]: !state.eventVisibility[action.group],
        },
      };

    case 'match/select':
      // A different match is a different timeline; never carry a playhead across.
      return {
        ...state,
        selectedMatch: action.match,
        focusedJourney: null,
        playback: { ...INITIAL_PLAYBACK, speed: state.playback.speed },
      };

    case 'journey/focus':
      return { ...state, focusedJourney: action.journey };

    case 'heatmap/mode':
      if (state.heatmapMode === action.mode) return state;
      return { ...state, heatmapMode: action.mode };

    case 'heatmap/intensity':
      return {
        ...state,
        heatmapIntensity: Math.min(2, Math.max(0.3, action.intensity)),
      };

    case 'region/set':
      return { ...state, region: action.region };

    case 'region/clear':
      if (!state.region) return state;
      return { ...state, region: null };

    case 'playback/toggle':
      return { ...state, playback: { ...state.playback, playing: !state.playback.playing } };

    case 'playback/pause':
      if (!state.playback.playing) return state;
      return { ...state, playback: { ...state.playback, playing: false } };

    case 'playback/seek':
      // Seeking pauses: scrubbing while the clock runs fights the user for the playhead.
      return {
        ...state,
        playback: {
          ...state.playback,
          time: clampTime(action.time, action.duration),
          playing: false,
        },
      };

    case 'playback/tick':
      if (!state.playback.playing && !action.ended) return state;
      return {
        ...state,
        playback: {
          ...state.playback,
          time: action.time,
          playing: action.ended ? false : state.playback.playing,
        },
      };

    case 'playback/reset':
      return { ...state, playback: { ...INITIAL_PLAYBACK, speed: state.playback.speed } };

    case 'playback/speed':
      // Speed changes only affect what happens next; the playhead stays put.
      return { ...state, playback: { ...state.playback, speed: action.speed } };

    case 'filters/reset':
      // Map and event-layer visibility are viewing preferences, not data filters, and
      // are deliberately preserved.
      return {
        ...state,
        selectedDates: new Set(),
        actorVisibility: DEFAULT_ACTORS,
        selectedMatch: null,
        focusedJourney: null,
        playback: { ...INITIAL_PLAYBACK, speed: state.playback.speed },
      };

    case 'filters/reconcile': {
      let next = state;
      if (action.match !== undefined && action.match !== state.selectedMatch) {
        next = {
          ...next,
          selectedMatch: action.match,
          playback: { ...INITIAL_PLAYBACK, speed: state.playback.speed },
        };
      }
      if (action.journey !== undefined && action.journey !== state.focusedJourney) {
        next = { ...next, focusedJourney: action.journey };
      }
      return next;
    }

    case 'tracks/loading':
      return { ...state, tracksLoading: action.mapId, tracksError: null };

    case 'tracks/loaded': {
      const tracks = new Map(state.tracks);
      tracks.set(action.mapId, action.tracks);
      return { ...state, tracks, tracksLoading: null };
    }

    case 'tracks/failed':
      return { ...state, tracksLoading: null, tracksError: action.error };

    default:
      return state;
  }
}

function toLoadError(cause: unknown): LoadError {
  if (cause instanceof DataLoadError) {
    return { message: cause.message, detail: cause.detail, fatal: cause.kind === 'schema' };
  }
  return {
    message: 'Something went wrong loading the data.',
    detail: cause instanceof Error ? cause.message : String(cause),
    fatal: false,
  };
}

const StateContext = createContext<AppState | null>(null);
const DispatchContext = createContext<Dispatch<Action> | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'dataset/loading' });
    loadDataset()
      .then((dataset) => {
        if (!cancelled) dispatch({ type: 'dataset/loaded', dataset });
      })
      .catch((cause: unknown) => {
        if (!cancelled) dispatch({ type: 'dataset/failed', error: toLoadError(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Track data is fetched per map, on demand, and cached for the session.
  //
  // In-flight requests are tracked in a ref rather than in reducer state. Depending on
  // `tracksLoading` here would be self-invalidating: the effect dispatches it, the state
  // change re-runs the effect, and the cleanup would cancel the very request it just
  // started. A ref also survives StrictMode's double-invoke, so the fetch happens once.
  //
  // There is no cancellation because the result is keyed by map and merely populates a
  // cache: a late arrival is still correct, so there is no stale-write hazard.
  const { mapId, tracks } = state;
  const requestedRef = useRef<Set<MapId>>(new Set());

  useEffect(() => {
    if (!mapId || tracks.has(mapId) || requestedRef.current.has(mapId)) return;
    requestedRef.current.add(mapId);
    dispatch({ type: 'tracks/loading', mapId });
    loadMapTracks(mapId)
      .then((loaded) => dispatch({ type: 'tracks/loaded', mapId, tracks: loaded }))
      .catch((cause: unknown) => {
        // Allow a retry to re-request this map.
        requestedRef.current.delete(mapId);
        dispatch({ type: 'tracks/failed', error: toLoadError(cause) });
      });
  }, [mapId, tracks]);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <SelectionProvider state={state}>{children}</SelectionProvider>
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState(): AppState {
  const state = useContext(StateContext);
  if (!state) throw new Error('useAppState must be used inside <AppStateProvider>');
  return state;
}

export function useDispatch(): Dispatch<Action> {
  const dispatch = useContext(DispatchContext);
  if (!dispatch) throw new Error('useDispatch must be used inside <AppStateProvider>');
  return dispatch;
}

// --------------------------------------------------------------------------------------
// Derived selection
// --------------------------------------------------------------------------------------

export interface Selection extends FilterResult {
  /**
   * Per-track-slot lookup tables for the active map, aligned to `MapTracks.journeyIds`.
   *
   * Computed once here rather than in each consumer: MapCanvas and RegionInspector both
   * need them, and each was independently allocating two Uint8Arrays and a Set of every
   * visible journey id on every selection change.
   */
  visibleSlots: Uint8Array | null;
  slotIsBot: Uint8Array | null;
  /** Track slot of the focused journey, or -1. */
  selectedSlot: number;
}

const SelectionContext = createContext<Selection | null>(null);

/**
 * Computes the filter result once per state change and shares it.
 *
 * Each consumer previously ran its own `useMemo`, so the same scan happened once per
 * component. One computation in the provider keeps it to one.
 */
function SelectionProvider({ state, children }: { state: AppState; children: ReactNode }) {
  const dispatch = useDispatch();

  const filters: FilterState = useMemo(
    () => ({
      mapId: state.mapId,
      dates: state.selectedDates,
      actors: state.actorVisibility,
      match: state.selectedMatch,
    }),
    [state.mapId, state.selectedDates, state.actorVisibility, state.selectedMatch],
  );

  const filtered = useMemo(
    () => computeFilters(state.dataset, filters),
    [state.dataset, filters],
  );

  const mapTracks = state.mapId ? state.tracks.get(state.mapId) : undefined;
  const { dataset, focusedJourney } = state;

  const selection = useMemo<Selection>(() => {
    if (!mapTracks || !dataset) {
      return { ...filtered, visibleSlots: null, slotIsBot: null, selectedSlot: -1 };
    }
    const visible = new Uint8Array(mapTracks.journeyCount);
    const isBot = new Uint8Array(mapTracks.journeyCount);
    const allowed = new Set(filtered.journeyIds);
    let focused = -1;

    for (let slot = 0; slot < mapTracks.journeyCount; slot++) {
      const journeyId = mapTracks.journeyIds[slot]!;
      visible[slot] = allowed.has(journeyId) ? 1 : 0;
      isBot[slot] = dataset.journeys[journeyId]?.actorType === 'bot' ? 1 : 0;
      if (focusedJourney !== null && journeyId === focusedJourney) focused = slot;
    }
    return { ...filtered, visibleSlots: visible, slotIsBot: isBot, selectedSlot: focused };
  }, [filtered, mapTracks, dataset, focusedJourney]);

  // Reconcile selections the current filters have invalidated. Doing this centrally
  // covers every filter path, and preserves a selection that is still valid rather than
  // clearing it defensively on any filter touch.
  const { selectedMatch } = state;
  useEffect(() => {
    const staleMatch = selectedMatch !== null && !selection.matchIsValid;
    const staleJourney =
      focusedJourney !== null && !selection.journeyIds.includes(focusedJourney);
    if (!staleMatch && !staleJourney) return;
    dispatch({
      type: 'filters/reconcile',
      ...(staleMatch ? { match: null } : {}),
      ...(staleJourney ? { journey: null } : {}),
    });
  }, [dispatch, selection, selectedMatch, focusedJourney]);

  return (
    <SelectionContext.Provider value={selection}>{children}</SelectionContext.Provider>
  );
}

export function useSelection(): Selection {
  const selection = useContext(SelectionContext);
  if (!selection) throw new Error('useSelection must be used inside <AppStateProvider>');
  return selection;
}

/** True when every data filter is at its default. */
export function useFiltersAreDefault(): boolean {
  const { mapId, selectedDates, actorVisibility, selectedMatch } = useAppState();
  return isDefaultFilterState({
    mapId,
    dates: selectedDates,
    actors: actorVisibility,
    match: selectedMatch,
  });
}
