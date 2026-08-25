/**
 * Derived statistics for a single journey.
 *
 * Everything here is computed from values that exist in the telemetry. Where a figure is
 * an estimate rather than a measurement, the return type says so and carries the
 * information a caller needs to caveat it honestly.
 */

import type { JourneyModel, MapTracks } from '../data/model';
import { EventCode, MOVEMENT_CODES } from '../data/types';

/**
 * Gap threshold, in seconds.
 *
 * Movement is sampled at a ~5 s cadence (p95 = 10 s, p99 = 25 s), but gaps of up to
 * 518 s occur. Beyond this threshold two consecutive samples cannot be treated as a
 * single continuous movement, so the segment between them is excluded from distance and
 * drawn as an explicit "unknown" connector rather than a travelled path.
 */
export const GAP_SECONDS = 30;

export interface TravelEstimate {
  /**
   * Sum of straight-line ground distances between consecutive movement samples, in
   * world units. An ESTIMATE, and a lower bound: real paths curve between samples.
   */
  distanceWorldUnits: number;
  /** Segments included in the sum. */
  segments: number;
  /** Segments excluded because the sampling gap exceeded {@link GAP_SECONDS}. */
  gapsExcluded: number;
  /** Longest sampling gap observed, in seconds. */
  longestGapSec: number;
  /** Movement samples the estimate is based on. */
  sampleCount: number;
  /** True when there are too few samples to estimate anything. */
  insufficientData: boolean;
}

/**
 * Estimate ground distance travelled from sampled positions.
 *
 * Uses the XZ plane only: `y` is elevation, and including it would inflate the figure
 * with vertical movement that a top-down travel distance should not contain.
 *
 * Segments spanning a gap longer than {@link GAP_SECONDS} are excluded rather than
 * bridged. Bridging a 518 s gap with a straight line would add hundreds of world units
 * of travel that was never observed.
 */
export function estimateTravel(
  tracks: MapTracks,
  slot: number,
  gapSeconds = GAP_SECONDS,
): TravelEstimate {
  const start = tracks.offsets[slot] ?? 0;
  const end = tracks.offsets[slot + 1] ?? start;

  let distance = 0;
  let segments = 0;
  let gapsExcluded = 0;
  let longestGap = 0;
  let sampleCount = 0;

  let previousIndex = -1;
  for (let i = start; i < end; i++) {
    if (!MOVEMENT_CODES.has(tracks.eventType[i] ?? -1)) continue;
    sampleCount++;

    if (previousIndex >= 0) {
      const dt = (tracks.tRel[i] ?? 0) - (tracks.tRel[previousIndex] ?? 0);
      if (dt > longestGap) longestGap = dt;

      if (dt > gapSeconds) {
        gapsExcluded++;
      } else {
        const dx = (tracks.worldX[i] ?? 0) - (tracks.worldX[previousIndex] ?? 0);
        const dz = (tracks.worldZ[i] ?? 0) - (tracks.worldZ[previousIndex] ?? 0);
        distance += Math.hypot(dx, dz);
        segments++;
      }
    }
    previousIndex = i;
  }

  return {
    distanceWorldUnits: distance,
    segments,
    gapsExcluded,
    longestGapSec: longestGap,
    sampleCount,
    insufficientData: sampleCount < 2,
  };
}

export interface JourneySummary {
  /** Kills the actor dealt: human-vs-human plus human-vs-bot. */
  kills: number;
  /** Deaths the actor suffered, from any cause. */
  deaths: number;
  /** Deaths attributable to the storm specifically. */
  stormDeaths: number;
  /** Loot pickups, after exact-duplicate removal. */
  loot: number;
  /** Movement samples recorded. */
  samples: number;
  /**
   * Seconds between the actor's first and last recorded event.
   *
   * This is the OBSERVED telemetry window, not necessarily the actor's full time in the
   * match: the export carries no join or leave event.
   */
  observedDurationSec: number;
}

export function summarise(journey: JourneyModel): JourneySummary {
  const counts = journey.eventCounts;
  return {
    kills: counts.Kill + counts.BotKill,
    deaths: counts.Killed + counts.BotKilled + counts.KilledByStorm,
    stormDeaths: counts.KilledByStorm,
    loot: counts.Loot,
    samples: journey.sampleCount,
    observedDurationSec: journey.durationSec,
  };
}

/** `372` -> `6:12`. */
export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

/** Event code -> the label shown in the UI. */
export const EVENT_LABELS: Record<number, string> = {
  [EventCode.Kill]: 'Kill (player)',
  [EventCode.BotKill]: 'Kill (bot)',
  [EventCode.Killed]: 'Killed by player',
  [EventCode.BotKilled]: 'Killed by bot',
  [EventCode.KilledByStorm]: 'Killed by storm',
  [EventCode.Loot]: 'Loot',
  [EventCode.Position]: 'Position',
  [EventCode.BotPosition]: 'Position (bot)',
};
