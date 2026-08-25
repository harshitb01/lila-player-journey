import { formatDuration } from '../analysis/journeyStats';
import type { JourneyModel, MatchModel } from '../data/model';
import { MARKER_BY_CODE } from '../render/eventMarkers';
import type { PickedEvent } from '../render/renderer';

export interface HoverTarget {
  event: PickedEvent;
  journey: JourneyModel;
  match: MatchModel | undefined;
}

/**
 * Hover readout for a single event marker.
 *
 * Exactly one of these exists in the DOM regardless of how many markers are on screen —
 * markers themselves are canvas geometry. It is positioned absolutely and never
 * intercepts pointer events, so it cannot steal the hover it is describing.
 */
export function EventTooltip({
  target,
  container,
}: {
  target: HoverTarget | null;
  container: { width: number; height: number };
}) {
  if (!target) return null;

  const spec = MARKER_BY_CODE.get(target.event.code);
  if (!spec) return null;

  const { event, journey, match } = target;
  const absolute = match
    ? new Date((match.startedAt + event.tRel) * 1000).toISOString().replace('T', ' ').slice(0, 19)
    : null;

  // Flip the tooltip toward the centre so it never runs off the canvas edge.
  const flipX = event.canvasX > container.width - 240;
  const flipY = event.canvasY > container.height - 150;
  const style: React.CSSProperties = {
    left: flipX ? undefined : event.canvasX + 14,
    right: flipX ? container.width - event.canvasX + 14 : undefined,
    top: flipY ? undefined : event.canvasY + 14,
    bottom: flipY ? container.height - event.canvasY + 14 : undefined,
  };

  return (
    <div
      role="tooltip"
      style={style}
      className="pointer-events-none absolute z-30 w-[230px] rounded-md border border-edge bg-surface-1/97 p-2.5 shadow-xl backdrop-blur-sm"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
          style={{ background: spec.colour }}
        />
        <span className="font-medium text-ink-0">{spec.label}</span>
      </div>
      <p className="mb-2 text-[11px] leading-snug text-ink-2">{spec.description}</p>

      <dl className="space-y-0.5 text-[11px]">
        <div className="flex justify-between gap-2">
          <dt className="text-ink-2">Match time</dt>
          <dd className="tabular-nums text-ink-0">{formatDuration(event.tRel)}</dd>
        </div>
        {absolute && (
          <div className="flex justify-between gap-2">
            <dt className="text-ink-2">UTC</dt>
            <dd className="tabular-nums text-ink-1">{absolute}</dd>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <dt className="text-ink-2">Actor</dt>
          <dd className="truncate font-mono text-ink-1" title={journey.userId}>
            {journey.userId.length > 12 ? `${journey.userId.slice(0, 8)}…` : journey.userId}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-2">Type</dt>
          <dd className="text-ink-1">{journey.actorType === 'bot' ? 'Bot' : 'Human'}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-2">World x, z</dt>
          <dd className="tabular-nums text-ink-1">
            {event.worldX.toFixed(1)}, {event.worldZ.toFixed(1)}
          </dd>
        </div>
      </dl>

      {/*
        The schema carries no target id. Saying so is more useful than leaving a reader to
        assume the counterparty is knowable or, worse, to infer it from a nearby marker.
      */}
      {spec.group !== 'loot' && (
        <p className="mt-2 border-t border-edge pt-1.5 text-[10px] leading-snug text-ink-2">
          No counterparty is recorded for this event — the schema stores only the acting
          player.
        </p>
      )}
    </div>
  );
}
