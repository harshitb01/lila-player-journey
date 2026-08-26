import { useAppState } from '../state/store';

/**
 * Disclosure surface for the pipeline's anomaly report, read straight from
 * `manifest.dataQuality`. A designer who acts on a number deserves to know how it was
 * made. See UX_SPEC.md §14.
 */
export function DataQualityPanel({ onClose }: { onClose: () => void }) {
  const { dataset } = useAppState();
  if (!dataset) return null;

  const { totals, dropped } = dataset;

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/50 p-8">
      <div className="max-h-full w-[min(44rem,100%)] overflow-y-auto rounded-lg border border-edge bg-surface-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="font-semibold text-ink-0">Data quality</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-2 hover:text-ink-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="border-b border-edge px-5 py-3 text-ink-1">
          <p>
            {totals.sourceRows.toLocaleString()} source rows →{' '}
            <strong className="text-ink-0">{totals.rows.toLocaleString()}</strong> after
            removing {(dropped.duplicateFileRows + dropped.duplicateRows).toLocaleString()}{' '}
            duplicates ({dropped.duplicateFileRows} from one file shipped twice,{' '}
            {dropped.duplicateRows.toLocaleString()} exact duplicate rows).
          </p>
          <p className="mt-1.5 text-ink-2">
            {totals.journeys.toLocaleString()} journeys ·{' '}
            {totals.matches.toLocaleString()} matches · {totals.players.toLocaleString()}{' '}
            players
          </p>
        </div>

        <ul className="divide-y divide-edge">
          {dataset.dataQuality.map((note) => (
            <li key={note.category} className="px-5 py-3">
              <div className="mb-1 flex items-baseline gap-2">
                <span className="font-mono text-[12px] text-warn">
                  {note.category}
                </span>
                <span className="tabular-nums text-ink-2">
                  {note.count.toLocaleString()}
                </span>
              </div>
              <p className="leading-relaxed text-ink-1">{note.detail}</p>
            </li>
          ))}
        </ul>

        <div className="border-t border-edge px-5 py-3 text-ink-2">
          <p>
            <strong className="text-ink-1">Not measurable from this dataset:</strong> no
            extraction or survival event exists in the telemetry, so extraction rate
            cannot be computed. Human-vs-human combat totals 6 rows across all 796
            matches.
          </p>
        </div>
      </div>
    </div>
  );
}
