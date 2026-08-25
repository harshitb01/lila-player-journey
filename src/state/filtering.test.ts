import { describe, expect, it } from 'vitest';

import type { Dataset, JourneyModel, MatchModel } from '../data/model';
import { EVENT_NAMES, type EventName } from '../data/types';
import type { MapId } from '../utils/coordinates';
import {
  computeFilters,
  isDefaultFilterState,
  type FilterState,
} from './filtering';

function counts(partial: Partial<Record<EventName, number>>): Record<EventName, number> {
  const base = Object.fromEntries(EVENT_NAMES.map((n) => [n, 0])) as Record<
    EventName,
    number
  >;
  return { ...base, ...partial };
}

interface Spec {
  map: MapId;
  date: string;
  actor: 'human' | 'bot';
  match: number;
  events?: Partial<Record<EventName, number>>;
}

/** Builds a minimal Dataset with the indexes `computeFilters` relies on. */
function makeDataset(specs: Spec[]): Dataset {
  const journeys: JourneyModel[] = specs.map((spec, id) => ({
    id,
    userId: `u${id}`,
    match: spec.match,
    mapId: spec.map,
    date: spec.date,
    sourceFolder: 'February_10',
    actorType: spec.actor,
    idFormat: spec.actor === 'bot' ? 'numeric' : 'uuid',
    actorIdConflict: false,
    startTRel: 0,
    durationSec: 300,
    sampleCount: 10,
    eventCounts: counts(spec.events ?? { Position: 10 }),
  }));

  const matchIds = [...new Set(specs.map((s) => s.match))].sort((a, b) => a - b);
  const matches: MatchModel[] = matchIds.map((id) => {
    const members = journeys.filter((j) => j.match === id);
    return {
      id,
      matchId: `m${id}.nakama-0`,
      mapId: members[0]!.mapId,
      startedAt: 1_770_000_000 + id * 600,
      durationSec: 300,
      journeys: members.map((j) => j.id),
      isPartialRoster: members.length <= 1,
    };
  });

  const journeysByMap = new Map<MapId, number[]>();
  const journeysByDate = new Map<string, number[]>();
  const matchesByMap = new Map<MapId, number[]>();
  for (const journey of journeys) {
    journeysByMap.set(journey.mapId, [...(journeysByMap.get(journey.mapId) ?? []), journey.id]);
    journeysByDate.set(journey.date, [...(journeysByDate.get(journey.date) ?? []), journey.id]);
  }
  for (const match of matches) {
    matchesByMap.set(match.mapId, [...(matchesByMap.get(match.mapId) ?? []), match.id]);
  }

  return {
    contentHash: 'test',
    totals: { sourceRows: 0, rows: 0, journeys: journeys.length, matches: matches.length, players: 0 },
    dates: [...new Set(specs.map((s) => s.date))].sort(),
    dropped: { duplicateFileRows: 0, duplicateRows: 0 },
    dataQuality: [],
    maps: [],
    mapsById: new Map(),
    matches,
    journeys,
    journeysByMap,
    journeysByDate,
    matchesByMap,
  };
}

const DATASET = makeDataset([
  { map: 'AmbroseValley', date: '2026-02-10', actor: 'human', match: 0, events: { Position: 10, Loot: 3 } },
  { map: 'AmbroseValley', date: '2026-02-10', actor: 'bot', match: 0, events: { BotPosition: 8 } },
  { map: 'AmbroseValley', date: '2026-02-11', actor: 'human', match: 1, events: { Position: 12, Kill: 1 } },
  { map: 'Lockdown', date: '2026-02-10', actor: 'human', match: 2, events: { Position: 5 } },
  { map: 'Lockdown', date: '2026-02-12', actor: 'bot', match: 3, events: { BotPosition: 4 } },
]);

function state(overrides: Partial<FilterState> = {}): FilterState {
  return {
    mapId: 'AmbroseValley',
    dates: new Set(),
    actors: { human: true, bot: true },
    match: null,
    ...overrides,
  };
}

describe('filtering by map, date, actor and match', () => {
  it('scopes to the selected map', () => {
    expect(computeFilters(DATASET, state()).journeyIds).toEqual([0, 1, 2]);
    expect(computeFilters(DATASET, state({ mapId: 'Lockdown' })).journeyIds).toEqual([3, 4]);
  });

  it('treats an empty date set as "all dates"', () => {
    expect(computeFilters(DATASET, state()).journeyIds).toHaveLength(3);
  });

  it('filters by date', () => {
    const result = computeFilters(DATASET, state({ dates: new Set(['2026-02-11']) }));
    expect(result.journeyIds).toEqual([2]);
  });

  it('filters by actor visibility', () => {
    const humans = computeFilters(DATASET, state({ actors: { human: true, bot: false } }));
    expect(humans.journeyIds).toEqual([0, 2]);
    const bots = computeFilters(DATASET, state({ actors: { human: false, bot: true } }));
    expect(bots.journeyIds).toEqual([1]);
  });

  it('returns nothing when both actor types are hidden', () => {
    const result = computeFilters(DATASET, state({ actors: { human: false, bot: false } }));
    expect(result.journeyIds).toEqual([]);
  });

  it('filters by match', () => {
    expect(computeFilters(DATASET, state({ match: 1 })).journeyIds).toEqual([2]);
  });

  it('combines filters', () => {
    const result = computeFilters(
      DATASET,
      state({ dates: new Set(['2026-02-10']), actors: { human: true, bot: false } }),
    );
    expect(result.journeyIds).toEqual([0]);
  });

  it('aggregates event counts and point totals from the index', () => {
    const result = computeFilters(DATASET, state());
    expect(result.eventCounts.Position).toBe(22);
    expect(result.eventCounts.Loot).toBe(3);
    expect(result.eventCounts.Kill).toBe(1);
    expect(result.pointCount).toBe(10 + 3 + 8 + 12 + 1);
    expect(result.matchCount).toBe(2);
  });

  it('returns an empty result when no map is selected', () => {
    const result = computeFilters(DATASET, state({ mapId: null }));
    expect(result.journeyIds).toEqual([]);
    expect(result.matchOptions).toEqual([]);
  });
});

describe('cascade', () => {
  it('scopes date counts to the selected map', () => {
    const ambrose = computeFilters(DATASET, state()).dateOptions;
    expect(ambrose.find((o) => o.date === '2026-02-12')?.available).toBe(false);

    const lockdown = computeFilters(DATASET, state({ mapId: 'Lockdown' })).dateOptions;
    expect(lockdown.find((o) => o.date === '2026-02-12')?.available).toBe(true);
    expect(lockdown.find((o) => o.date === '2026-02-11')?.available).toBe(false);
  });

  it('scopes date counts to actor visibility', () => {
    const humansOnly = computeFilters(
      DATASET,
      state({ mapId: 'Lockdown', actors: { human: true, bot: false } }),
    );
    // 12 Feb on Lockdown is a bot-only journey, so it disappears when bots are hidden.
    expect(humansOnly.dateOptions.find((o) => o.date === '2026-02-12')?.count).toBe(0);
  });

  it('does NOT apply the date filter to its own option counts', () => {
    // The trap: if the date facet filtered itself, selecting 10 Feb would zero out the
    // count for 11 Feb and make it impossible to add.
    const result = computeFilters(DATASET, state({ dates: new Set(['2026-02-10']) }));
    const feb11 = result.dateOptions.find((o) => o.date === '2026-02-11');
    expect(feb11?.count).toBe(1);
    expect(feb11?.available).toBe(true);
    expect(feb11?.selected).toBe(false);
  });

  it('does NOT apply actor visibility to its own counts', () => {
    const result = computeFilters(DATASET, state({ actors: { human: true, bot: false } }));
    // Bots are hidden, but the toggle must still report how many there are to show.
    expect(result.actorCounts.bot).toBe(1);
    expect(result.actorCounts.human).toBe(2);
  });

  it('offers only matches that survive the map, date and actor filters', () => {
    expect(computeFilters(DATASET, state()).matchOptions).toEqual([1, 0]); // newest first
    expect(
      computeFilters(DATASET, state({ dates: new Set(['2026-02-11']) })).matchOptions,
    ).toEqual([1]);
    expect(
      computeFilters(DATASET, state({ actors: { human: false, bot: true } })).matchOptions,
    ).toEqual([0]);
  });

  it('keeps the match list independent of the match drill-down itself', () => {
    // Selecting match 1 must not reduce the list to only match 1.
    expect(computeFilters(DATASET, state({ match: 1 })).matchOptions).toEqual([1, 0]);
  });
});

describe('stale selection detection', () => {
  it('reports a match as valid while it passes the other filters', () => {
    expect(computeFilters(DATASET, state({ match: 0 })).matchIsValid).toBe(true);
  });

  it('reports a match as invalid once a date filter excludes it', () => {
    const result = computeFilters(
      DATASET,
      state({ match: 0, dates: new Set(['2026-02-11']) }),
    );
    expect(result.matchIsValid).toBe(false);
  });

  it('reports a match as invalid once actor visibility excludes all its journeys', () => {
    // Match 3 on Lockdown is bot-only.
    const result = computeFilters(
      DATASET,
      state({ mapId: 'Lockdown', match: 3, actors: { human: true, bot: false } }),
    );
    expect(result.matchIsValid).toBe(false);
  });

  it('reports a match as invalid when the map changes beneath it', () => {
    const result = computeFilters(DATASET, state({ mapId: 'Lockdown', match: 0 }));
    expect(result.matchIsValid).toBe(false);
  });

  it('treats "no match selected" as trivially valid', () => {
    expect(computeFilters(DATASET, state({ match: null })).matchIsValid).toBe(true);
  });
});

describe('path readability', () => {
  it('is false for an empty selection', () => {
    expect(computeFilters(DATASET, state({ match: 99 })).pathsReadable).toBe(false);
  });

  it('is false above the limit', () => {
    const many = makeDataset(
      Array.from({ length: 40 }, (_, i) => ({
        map: 'AmbroseValley' as MapId,
        date: '2026-02-10',
        actor: 'human' as const,
        match: i,
      })),
    );
    expect(computeFilters(many, state()).pathsReadable).toBe(false);
  });

  it('is true for a small selection', () => {
    expect(computeFilters(DATASET, state()).pathsReadable).toBe(true);
  });
});

describe('isDefaultFilterState', () => {
  it('is true only when nothing is filtered', () => {
    expect(isDefaultFilterState(state())).toBe(true);
    expect(isDefaultFilterState(state({ dates: new Set(['2026-02-10']) }))).toBe(false);
    expect(isDefaultFilterState(state({ actors: { human: true, bot: false } }))).toBe(false);
    expect(isDefaultFilterState(state({ match: 1 }))).toBe(false);
  });

  it('ignores the map, which is a view choice rather than a filter', () => {
    expect(isDefaultFilterState(state({ mapId: 'Lockdown' }))).toBe(true);
  });
});
