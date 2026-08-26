import { describe, expect, it } from 'vitest';

import type { MapTracks } from '../data/model';
import { initialState, reducer } from './store';

const tracks = (mapId: MapTracks['mapId']) => ({ mapId } as MapTracks);

describe('track request state', () => {
  it('keeps the active request state when another map finishes late', () => {
    const state = {
      ...initialState,
      mapId: 'GrandRift' as const,
      tracksLoading: { mapId: 'GrandRift' as const, requestId: 2 },
    };
    const next = reducer(state, {
      type: 'tracks/loaded',
      mapId: 'AmbroseValley',
      requestId: 1,
      tracks: tracks('AmbroseValley'),
    });

    expect(next.tracks.get('AmbroseValley')).toBeDefined();
    expect(next.tracksLoading).toEqual({ mapId: 'GrandRift', requestId: 2 });
  });

  it('ignores a stale failure instead of replacing the active map state', () => {
    const state = {
      ...initialState,
      mapId: 'GrandRift' as const,
      tracksLoading: { mapId: 'GrandRift' as const, requestId: 2 },
    };
    const next = reducer(state, {
      type: 'tracks/failed',
      mapId: 'AmbroseValley',
      requestId: 1,
      error: { message: 'late failure', fatal: false },
    });

    expect(next).toBe(state);
  });

  it('records a failure only for the matching active request', () => {
    const state = {
      ...initialState,
      mapId: 'GrandRift' as const,
      tracksLoading: { mapId: 'GrandRift' as const, requestId: 2 },
    };
    const next = reducer(state, {
      type: 'tracks/failed',
      mapId: 'GrandRift',
      requestId: 2,
      error: { message: 'failed', fatal: false },
    });

    expect(next.tracksLoading).toBeNull();
    expect(next.tracksError).toEqual({
      mapId: 'GrandRift',
      requestId: 2,
      error: { message: 'failed', fatal: false },
    });
  });

  it('turns Retry into a new effect trigger for the active map', () => {
    const state = {
      ...initialState,
      mapId: 'GrandRift' as const,
      trackRetryToken: 4,
      tracksError: {
        mapId: 'GrandRift' as const,
        requestId: 2,
        error: { message: 'failed', fatal: false },
      },
    };
    const next = reducer(state, { type: 'tracks/retry', mapId: 'GrandRift' });

    expect(next.trackRetryToken).toBe(5);
    expect(next.tracksError).toBeNull();
  });
});
