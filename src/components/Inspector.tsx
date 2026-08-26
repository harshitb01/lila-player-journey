import { useMemo } from 'react';

import { estimateTravel, formatDuration, summarise } from '../analysis/journeyStats';
import { useAppState, useDispatch } from '../state/store';

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-ink-2">{label}</dt>
      <dd className="text-right">
        <span className="tabular-nums text-ink-0">{value}</span>
        {hint && <span className="ml-1.5 text-[11px] text-ink-2">{hint}</span>}
      </dd>
    </div>
  );
}

/**
 * Detail panel for the selected journey.
 *
 * Every figure here is either a direct count from the telemetry or an explicitly
 * labelled estimate. Nothing is inferred: in particular the panel never reports whether
 * the actor survived or extracted, because no extraction, survival or match-end event
 * exists in this dataset.
 */
export function Inspector() {
  const { dataset, mapId, tracks, focusedJourney } = useAppState();
  const dispatch = useDispatch();

  const journey = focusedJourney !== null ? dataset?.journeys[focusedJourney] : null;
  const mapTracks = mapId ? tracks.get(mapId) : undefined;

  const travel = useMemo(() => {
    if (!journey || !mapTracks) return null;
    const slot = mapTracks.journeyIds.indexOf(journey.id);
    return slot < 0 ? null : estimateTravel(mapTracks, slot);
  }, [journey, mapTracks]);

  if (!journey || !dataset) return null;

  const summary = summarise(journey);
  const match = dataset.matches[journey.match];
  const isBot = journey.actorType === 'bot';

  return (
    <aside className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-edge bg-surface-1">
      <div className="flex items-start justify-between gap-2 border-b border-edge px-3 py-3">
        <div className="min-w-0">
          <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wider text-ink-2">
            Player
          </p>
          <p className="truncate font-mono text-[12px] text-ink-0" title={journey.userId}>
            {journey.userId}
          </p>
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: 'journey/focus', journey: null })}
          className="shrink-0 text-ink-2 hover:text-ink-0"
          aria-label="Clear selection"
        >
          ×
        </button>
      </div>

      <section className="border-b border-edge px-3 py-3">
        <div className="mb-2 flex items-center gap-2">
          {/* Shape and fill carry actor type, matching the map. Never colour alone. */}
          <span
            aria-hidden
            className={`inline-block h-2.5 w-2.5 ${
              isBot
                ? 'rounded-full border border-dashed border-[#8b98ad]'
                : 'rounded-full bg-[#dbe6f5]'
            }`}
          />
          <span className="text-ink-0">{isBot ? 'Bot' : 'Human player'}</span>
        </div>
        {journey.actorIdConflict && (
          <p className="rounded border border-warn-edge bg-warn-bg px-2 py-1.5 text-[11px] leading-relaxed text-warn">
            This id looks like a bot id but the journey emits human events. Classified as{' '}
            <strong>human</strong> by behaviour. See the data-quality notes.
          </p>
        )}
      </section>

      <section className="border-b border-edge px-3 py-3">
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-2">
          Observed
        </h3>
        <dl>
          <Row
            label="Duration"
            value={formatDuration(summary.observedDurationSec)}
            hint="observed"
          />
          <Row label="Movement samples" value={summary.samples.toLocaleString()} />
          <Row label="Kills" value={summary.kills.toLocaleString()} />
          <Row label="Deaths" value={summary.deaths.toLocaleString()} />
          {summary.stormDeaths > 0 && (
            <Row label="— by storm" value={summary.stormDeaths.toLocaleString()} />
          )}
          <Row label="Loot events" value={summary.loot.toLocaleString()} />
        </dl>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-2">
          Duration is the window between the first and last recorded event. The export
          carries no join or leave event, so it is not necessarily the actor's full time
          in the match.
        </p>
      </section>

      <section className="border-b border-edge px-3 py-3">
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-2">
          Travel — estimated
        </h3>
        {travel && !travel.insufficientData ? (
          <>
            <dl>
              <Row
                label="Ground distance"
                value={`≈ ${Math.round(travel.distanceWorldUnits).toLocaleString()}`}
                hint="world units"
              />
              <Row label="From segments" value={travel.segments.toLocaleString()} />
              {travel.gapsExcluded > 0 && (
                <Row label="Gaps excluded" value={travel.gapsExcluded.toLocaleString()} />
              )}
              <Row label="Longest gap" value={`${travel.longestGapSec}s`} />
            </dl>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-2">
              <strong className="text-ink-1">Estimated from sampled positions.</strong>{' '}
              Straight lines between samples taken about 5s apart, on the ground plane
              only — so this is a <em>lower bound</em> on distance actually walked.
              {travel.gapsExcluded > 0 && (
                <>
                  {' '}
                  {travel.gapsExcluded} segment
                  {travel.gapsExcluded === 1 ? '' : 's'} spanning a sampling gap {' '}
                  {travel.gapsExcluded === 1 ? 'was' : 'were'} excluded rather than
                  bridged.
                </>
              )}
            </p>
          </>
        ) : (
          <p className="text-[11px] leading-relaxed text-ink-2">
            Not enough movement samples to estimate travel
            {travel ? ` (${travel.sampleCount})` : ''}. The actor was recorded, but the
            telemetry is too sparse to describe a route.
          </p>
        )}
      </section>

      {match && (
        <section className="px-3 py-3">
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-2">
            Match
          </h3>
          <dl>
            <Row label="Date" value={journey.date} />
            <Row
              label="Started"
              value={new Date(match.startedAt * 1000).toISOString().slice(11, 19)}
              hint="UTC"
            />
            <Row label="Match length" value={formatDuration(match.durationSec)} />
            <Row label="Journeys recorded" value={String(match.journeys.length)} />
          </dl>
          {match.isPartialRoster && (
            <p className="mt-2 text-[11px] leading-relaxed text-ink-2">
              Only this journey was captured for the match. The true roster size is
              unknown.
            </p>
          )}
        </section>
      )}
    </aside>
  );
}
