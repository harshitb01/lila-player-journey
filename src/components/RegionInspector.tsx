import { useMemo } from 'react';

import { computeRegionStats, regionWorldSize, type RegionCategory } from '../render/region';
import { useAppState, useDispatch, useSelection } from '../state/store';

const LABELS: Record<RegionCategory, string> = {
  traffic: 'Traffic',
  kills: 'Kills',
  deaths: 'Deaths',
  storm: 'Storm deaths',
};

const SWATCHES: Record<RegionCategory, string> = {
  traffic: '#4da3ff',
  kills: '#ff8c42',
  deaths: '#ff4d5e',
  storm: '#b06cff',
};

/** The map-total this map's traffic count is compared against. Position + BotPosition. */
function mapTotal(category: RegionCategory, counts: ReturnType<typeof useSelection>['eventCounts']) {
  switch (category) {
    case 'traffic':
      return counts.Position + counts.BotPosition;
    case 'kills':
      return counts.Kill + counts.BotKill;
    case 'deaths':
      return counts.Killed + counts.BotKilled;
    case 'storm':
      return counts.KilledByStorm;
  }
}

/**
 * Region statistics — the number behind a heatmap hotspot.
 *
 * Shift+drag a rectangle on the canvas to open this. It answers the question the
 * heatmap's colour alone cannot: exactly how many kills/deaths/storm deaths/traffic
 * samples fall inside this specific area, and what share of the map's total that is.
 *
 * Counts are independent of the playback position, same as the heatmap: this is
 * standing context for the current filters, not a live overlay tied to the clock.
 */
export function RegionInspector() {
  const { dataset, mapId, tracks, region, actorVisibility } = useAppState();
  const dispatch = useDispatch();
  const selection = useSelection();

  const mapTracks = mapId ? tracks.get(mapId) : undefined;
  const map = mapId ? dataset?.mapsById.get(mapId) : null;

  // Recomputed only when the region or the underlying filtered selection changes —
  // never per animation frame. visibleSlots already encodes map/date/match/actor.
  const { visibleSlots, slotIsBot } = useMemo(() => {
    if (!mapTracks || !dataset) return { visibleSlots: null, slotIsBot: null };
    const visible = new Uint8Array(mapTracks.journeyCount);
    const isBot = new Uint8Array(mapTracks.journeyCount);
    const allowed = new Set(selection.journeyIds);
    for (let slot = 0; slot < mapTracks.journeyCount; slot++) {
      const journeyId = mapTracks.journeyIds[slot]!;
      visible[slot] = allowed.has(journeyId) ? 1 : 0;
      isBot[slot] = dataset.journeys[journeyId]?.actorType === 'bot' ? 1 : 0;
    }
    return { visibleSlots: visible, slotIsBot: isBot };
  }, [mapTracks, dataset, selection.journeyIds]);

  const stats = useMemo(
    () => computeRegionStats(mapTracks ?? null, visibleSlots, slotIsBot, region),
    [mapTracks, visibleSlots, slotIsBot, region],
  );

  if (!region || !map) return null;

  const size = regionWorldSize(region, map.config.scale);
  const categories: RegionCategory[] = ['traffic', 'kills', 'deaths', 'storm'];

  return (
    <div className="absolute left-4 top-4 z-10 w-64 rounded-md border border-edge bg-surface-1/95 p-3 shadow-xl backdrop-blur-sm">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-2">
          Region
        </h3>
        <button
          type="button"
          onClick={() => dispatch({ type: 'region/clear' })}
          className="text-ink-2 hover:text-ink-0"
          aria-label="Clear region"
        >
          ×
        </button>
      </div>

      <p className="mb-2.5 text-[11px] text-ink-2">
        ≈ {Math.round(size.width)} × {Math.round(size.depth)} world units
      </p>

      <dl className="space-y-1.5">
        {categories.map((category) => {
          const value = stats.counts[category];
          const total = mapTotal(category, selection.eventCounts);
          const pct = total > 0 ? (100 * value) / total : 0;
          return (
            <div key={category} className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ background: SWATCHES[category] }}
              />
              <dt className="flex-1 text-ink-1">{LABELS[category]}</dt>
              <dd className="tabular-nums text-ink-0">{value.toLocaleString()}</dd>
              {total > 0 && value > 0 && (
                <dd className="w-11 shrink-0 text-right tabular-nums text-[11px] text-ink-2">
                  {pct.toFixed(0)}%
                </dd>
              )}
            </div>
          );
        })}
      </dl>

      <div className="mt-2.5 border-t border-edge pt-2 text-[11px] text-ink-2">
        <p>
          {stats.journeys.toLocaleString()} journey{stats.journeys === 1 ? '' : 's'} pass
          through
          {stats.journeys > 0 &&
            (actorVisibility.human || actorVisibility.bot) &&
            ` (${stats.humans}H ${stats.bots}B)`}
          .
        </p>
        {stats.totalPoints > 0 && stats.totalPoints < 30 && (
          <p className="mt-1 text-[#e8c46a]">⚠ small sample (n={stats.totalPoints})</p>
        )}
        {stats.totalPoints === 0 && (
          <p className="mt-1">Nothing recorded here under the current filters.</p>
        )}
      </div>
    </div>
  );
}
