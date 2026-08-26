import type { EventName } from '../data/types';
import {
  EVENT_GROUP_LABELS,
  GROUP_MEMBERS,
  type EventGroup,
} from '../render/eventMarkers';
import { HEATMAP_LABELS, type HeatmapMode } from '../render/heatmap';
import { EventGlyph } from './EventGlyph';
import { formatDuration } from '../analysis/journeyStats';
import { useAppState, useDispatch, useSelection } from '../state/store';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="shrink-0 border-b border-edge px-3 py-3">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-2">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Sample size behind everything on screen.
 *
 * Always visible so a filtered view can never be misread as the whole dataset.
 */
function ShowingStats() {
  const { dataset, mapId } = useAppState();
  const selection = useSelection();
  const map = mapId ? dataset?.mapsById.get(mapId) : null;
  const isFiltered =
    map != null && selection.journeyIds.length !== map.totals.journeys;

  const rows = [
    { label: 'journeys', value: selection.journeyIds.length },
    { label: 'matches', value: selection.matchCount },
    { label: 'points', value: selection.pointCount },
  ];

  return (
    <Section title="Showing">
      <dl className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between">
            <dd className="tabular-nums text-[15px] font-medium text-ink-0">
              {row.value.toLocaleString()}
            </dd>
            <dt className="text-ink-2">{row.label}</dt>
          </div>
        ))}
      </dl>
      {isFiltered && map && (
        <p className="mt-2 text-[11px] text-ink-2">
          filtered from {map.totals.journeys.toLocaleString()} on {map.displayName}
        </p>
      )}
      {selection.journeyIds.length > 0 && selection.journeyIds.length < 30 && (
        <p className="mt-2 text-[11px] text-warn">
          ⚠ small sample (n={selection.journeyIds.length})
        </p>
      )}
    </Section>
  );
}

/**
 * Heatmap layer selection and opacity.
 *
 * Modes are mutually exclusive: two overlaid density fields are unreadable, and the
 * question is almost always "where does X happen", not "where do X and Y overlap".
 */
function HeatmapControls() {
  const { heatmapMode, heatmapIntensity } = useAppState();
  const dispatch = useDispatch();
  const selection = useSelection();

  const counts: Record<Exclude<HeatmapMode, 'none'>, number> = {
    traffic: selection.eventCounts.Position + selection.eventCounts.BotPosition,
    kills: selection.eventCounts.Kill + selection.eventCounts.BotKill,
    deaths:
      selection.eventCounts.Killed +
      selection.eventCounts.BotKilled +
      selection.eventCounts.KilledByStorm,
  };

  const modes: HeatmapMode[] = ['traffic', 'kills', 'deaths', 'none'];
  const active = heatmapMode !== 'none' ? heatmapMode : null;

  return (
    <Section title="Heatmap">
      <ul className="space-y-0.5">
        {modes.map((mode) => {
          const on = heatmapMode === mode;
          const count = mode === 'none' ? null : counts[mode];
          return (
            <li key={mode}>
              <button
                type="button"
                onClick={() => dispatch({ type: 'heatmap/mode', mode })}
                aria-pressed={on}
                className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors ${
                  on ? 'bg-surface-2 text-ink-0' : 'text-ink-2 hover:bg-surface-2/60'
                }`}
              >
                <span
                  aria-hidden
                  className={`h-2.5 w-2.5 shrink-0 rounded-full border ${
                    on ? 'border-accent bg-accent' : 'border-ink-2'
                  }`}
                />
                <span className="flex-1">
                  {mode === 'none' ? 'Off' : HEATMAP_LABELS[mode]}
                </span>
                {count !== null && (
                  <span className="tabular-nums text-ink-2">{count.toLocaleString()}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {active && (
        <>
          <label className="mt-2.5 flex items-center gap-2 text-ink-2">
            <span className="shrink-0 text-[11px]">Intensity</span>
            <input
              type="range"
              min={0.3}
              max={2}
              step={0.1}
              value={heatmapIntensity}
              onChange={(e) =>
                dispatch({ type: 'heatmap/intensity', intensity: Number(e.target.value) })
              }
              className="h-1 flex-1 cursor-pointer accent-accent"
              aria-label="Heatmap intensity"
            />
            <span className="w-7 shrink-0 text-right tabular-nums text-[11px]">
              {heatmapIntensity.toFixed(1)}×
            </span>
          </label>

          {/*
            Only conditional, actionable warnings live here. The standing caveat that
            shading is relative rather than an absolute rate belongs in the legend,
            beside the colour ramp it describes — not permanently in the rail.
          */}
          {counts[active] === 0 && (
            <p className="mt-2 text-[11px] leading-relaxed text-warn">
              No {HEATMAP_LABELS[active].toLowerCase()} events here — nothing to shade.
            </p>
          )}
          {counts[active] > 0 && counts[active] < 30 && (
            <p className="mt-2 text-[11px] leading-relaxed text-warn">
              Only {counts[active]} events — read the shape with caution.
            </p>
          )}
        </>
      )}
    </Section>
  );
}

/** Which raw event names roll up into each toggle group. */
const GROUP_EVENTS: Record<EventGroup, EventName[]> = {
  kills: ['Kill', 'BotKill'],
  deaths: ['Killed', 'BotKilled'],
  storm: ['KilledByStorm'],
  loot: ['Loot'],
};

/**
 * Event layer visibility, with the count each group contributes under the current
 * filter.
 *
 * Magnitude is shown before the designer commits to a layer: loot is an order of
 * magnitude more common than anything else and will swamp the map, which is why it is
 * off by default.
 */
function EventToggles() {
  const { eventVisibility } = useAppState();
  const dispatch = useDispatch();
  const selection = useSelection();

  // Counts already come from the single shared filter pass.
  const counts = selection.eventCounts;

  const groups = Object.keys(GROUP_EVENTS) as EventGroup[];

  return (
    <Section title="Events">
      <ul className="space-y-1">
        {groups.map((group) => {
          const on = eventVisibility[group];
          const total = GROUP_EVENTS[group].reduce((sum, name) => sum + counts[name], 0);
          const members = GROUP_MEMBERS[group];

          return (
            <li key={group}>
              <button
                type="button"
                onClick={() => dispatch({ type: 'events/toggle', group })}
                aria-pressed={on}
                className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors ${
                  on ? 'bg-surface-2 text-ink-0' : 'text-ink-2 hover:bg-surface-2/60'
                }`}
              >
                <span className="flex w-9 shrink-0 items-center gap-0.5">
                  {members.map((spec) => (
                    <EventGlyph key={spec.label} spec={spec} size={13} muted={!on} />
                  ))}
                </span>
                <span className="flex-1">{EVENT_GROUP_LABELS[group]}</span>
                <span className="tabular-nums text-ink-2">{total.toLocaleString()}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {/*
        Kept because it is measured, selection-dependent and changes how the layer reads.
        The standing "no target id in the schema" caveat is stated on every combat
        tooltip and in the legend; repeating it permanently here is noise.
      */}
      {eventVisibility.kills && counts.Kill + counts.Killed === 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-2">
          No player-vs-player kills here — all combat is versus bots.
        </p>
      )}
    </Section>
  );
}

/**
 * Journeys in the current selection, and the control for picking one.
 *
 * Listed only when the set is small enough to be meaningful; at 836 journeys a list is
 * not a useful way to find anything, so the map itself is the selection surface.
 */
function JourneyList() {
  const { dataset, focusedJourney } = useAppState();
  const dispatch = useDispatch();
  const selection = useSelection();
  const count = selection.journeyIds.length;

  if (!dataset) return null;

  // With hundreds of journeys visible there is no useful list to show, and a section
  // whose only content is an instruction to go do something else is wasted space in a
  // 260px rail. Render nothing; the map itself is the selection surface here.
  if (!selection.pathsReadable) return null;

  return (
    <Section title={`Journeys (${count})`}>
      <ul className="-mx-1 max-h-[30vh] space-y-px overflow-y-auto">
        {selection.journeyIds.map((id) => {
          const journey = dataset.journeys[id]!;
          const active = focusedJourney === id;
          const isBot = journey.actorType === 'bot';
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() =>
                  dispatch({ type: 'journey/focus', journey: active ? null : id })
                }
                aria-pressed={active}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${
                  active ? 'bg-surface-3 text-ink-0' : 'text-ink-1 hover:bg-surface-2'
                }`}
              >
                {/* Shape, not colour: filled dot = human, dashed ring = bot. */}
                <span
                  aria-hidden
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    isBot ? 'border border-dashed border-[#8b98ad]' : 'bg-[#dbe6f5]'
                  }`}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                  {journey.userId.slice(0, 8)}
                </span>
                <span className="tabular-nums text-ink-2">
                  {formatDuration(journey.durationSec)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * Match list — a drill-down rather than a filter, so it sits at the bottom.
 *
 * Options come from the cascade, so the list only ever offers matches that survive the
 * current map, date and actor filters. Selecting one that the next filter change
 * invalidates is handled centrally by reconciliation, not here.
 */
function MatchList() {
  const { dataset, selectedMatch } = useAppState();
  const dispatch = useDispatch();
  const selection = useSelection();

  if (!dataset) return null;

  const options = selection.matchOptions;
  const shown = options.slice(0, 300);

  return (
    <Section title={`Matches (${options.length.toLocaleString()})`}>
      {selectedMatch !== null && (
        <button
          type="button"
          onClick={() => dispatch({ type: 'match/select', match: null })}
          className="mb-2 text-accent hover:underline"
        >
          ◂ back to all matches
        </button>
      )}

      {options.length === 0 ? (
        <p className="text-ink-2">No matches pass the current filters.</p>
      ) : (
        <ul className="-mx-1 max-h-[38vh] min-h-[9rem] space-y-px overflow-y-auto">
          {shown.map((id) => {
            const match = dataset.matches[id];
            if (!match) return null;
            const humans = match.journeys.filter(
              (j) => dataset.journeys[j]?.actorType === 'human',
            ).length;
            const bots = match.journeys.length - humans;
            const time = new Date(match.startedAt * 1000).toISOString().slice(11, 16);
            const active = selectedMatch === id;

            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() =>
                    dispatch({ type: 'match/select', match: active ? null : id })
                  }
                  aria-pressed={active}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${
                    active ? 'bg-surface-3 text-ink-0' : 'text-ink-1 hover:bg-surface-2'
                  }`}
                >
                  <span className="tabular-nums text-ink-1">{time}</span>
                  <span className="flex-1" />
                  {/*
                    286 of 300 rows are "1H 0B" — printing it on every row spends a
                    column to say nothing 95% of the time and hides the handful of
                    matches that actually have a bot squad. Show the roster only when
                    it carries information.
                  */}
                  {(bots > 0 || humans > 1) && (
                    <span
                      className="shrink-0 rounded-sm bg-surface-3 px-1 text-[11px] tabular-nums text-ink-1"
                      title={`${humans} human${humans === 1 ? '' : 's'}, ${bots} bot${bots === 1 ? '' : 's'} recorded`}
                    >
                      {humans > 1 ? `${humans}H` : ''}
                      {humans > 1 && bots > 0 ? ' ' : ''}
                      {bots > 0 ? `${bots}B` : ''}
                    </span>
                  )}
                  <span className="w-10 shrink-0 text-right tabular-nums text-ink-2">
                    {formatDuration(match.durationSec)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {options.length > shown.length && (
        <p className="mt-2 text-[11px] text-ink-2">
          Newest {shown.length} of {options.length.toLocaleString()}.
        </p>
      )}
    </Section>
  );
}

export function LeftRail() {
  return (
    <aside className="flex w-[260px] shrink-0 flex-col overflow-y-auto border-r border-edge bg-surface-1">
      <ShowingStats />
      <HeatmapControls />
      <EventToggles />
      <JourneyList />
      <MatchList />
    </aside>
  );
}
