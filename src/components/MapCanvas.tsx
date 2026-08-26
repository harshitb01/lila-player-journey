import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { MapModel, MapTracks } from '../data/model';
import {
  BLUR_RADIUS,
  blurGrid,
  buildGrid,
  gridToRgba,
  intensityCap,
} from '../render/heatmap';
import { advance } from '../render/playback';
import { pickEvent, pickJourney, render, type RenderOptions } from '../render/renderer';
import { regionFromCanvasDrag } from '../render/region';
import { computeFitRect, resizeCanvasToDisplaySize } from '../render/viewport';
import { PATH_READABILITY_LIMIT, useAppState, useDispatch, useSelection } from '../state/store';
import { EventTooltip, type HoverTarget } from './EventTooltip';
import { EmptySelection, MapArtworkWarning, TracksLoading } from './States';

/**
 * Tracks an element's content-box size.
 *
 * Measures synchronously on mount rather than waiting for the first ResizeObserver
 * callback. That callback is driven by the rendering lifecycle and is not guaranteed to
 * arrive promptly — in a backgrounded or non-compositing tab it may not arrive at all,
 * which would leave the canvas at its 300x150 default and render nothing. The observer
 * then handles subsequent changes, with a window `resize` listener as a cheap fallback.
 */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      const box = element.getBoundingClientRect();
      setSize((previous) =>
        previous.width === box.width && previous.height === box.height
          ? previous
          : { width: box.width, height: box.height },
      );
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return { ref, size };
}

type ImageState = 'idle' | 'loading' | 'ready' | 'failed';

/** Loads the minimap artwork. Failure is non-fatal — telemetry stays accurate. */
function useMinimapImage(map: MapModel | null) {
  const [state, setState] = useState<ImageState>('idle');
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!map) {
      imageRef.current = null;
      setState('idle');
      return;
    }
    let cancelled = false;
    const image = new Image();
    setState('loading');
    image.onload = () => {
      if (cancelled) return;
      imageRef.current = image;
      setState('ready');
    };
    image.onerror = () => {
      if (cancelled) return;
      imageRef.current = null;
      setState('failed');
    };
    image.src = map.image.url;
    return () => {
      cancelled = true;
    };
  }, [map]);

  return { image: imageRef, state };
}

export function MapCanvas() {
  const {
    dataset,
    mapId,
    tracks,
    tracksLoading,
    eventVisibility,
    selectedMatch,
    playback,
    heatmapMode,
    heatmapIntensity,
    region,
  } = useAppState();
  const dispatch = useDispatch();
  const selection = useSelection();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { ref: containerRef, size } = useElementSize<HTMLDivElement>();

  const map = mapId ? (dataset?.mapsById.get(mapId) ?? null) : null;
  const mapTracks: MapTracks | null = mapId ? (tracks.get(mapId) ?? null) : null;
  const { image, state: imageState } = useMinimapImage(map);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  /**
   * In-progress Shift+drag, in canvas pixels. Local React state rather than a ref:
   * unlike the playback clock this is a manual, human-paced interaction (not an
   * automatic 60Hz loop), so ordinary re-renders are the right tool and keep the code
   * consistent with every other interaction in this component.
   */
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; current: { x: number; y: number } } | null>(
    null,
  );

  // True aspect of the artwork. GrandRift is 2160x2158, so this must not be assumed 1.
  const aspect = map ? map.image.naturalWidth / map.image.naturalHeight : 1;
  const rect = useMemo(() => computeFitRect(size, aspect), [size, aspect]);

  // Per-slot lookup tables come from the shared selection, so the scan that builds them
  // happens once for the whole app rather than once per consumer.
  const { visibleSlots, slotIsBot, selectedSlot } = selection;

  /**
   * Spatial aggregation, memoised on the inputs that can change it.
   *
   * Notably absent from the dependencies: `playback.time`. The heatmap summarises the
   * whole filtered selection and stays fixed while the clock runs, so playback costs
   * nothing here and the field does not flicker under the playhead.
   */
  const heatmapStats = useMemo(() => {
    if (!mapTracks || heatmapMode === 'none') return null;
    const raw = buildGrid(mapTracks, visibleSlots, heatmapMode);
    if (raw.total === 0) return { grid: raw, cap: 0, total: 0 };
    const grid = blurGrid(raw, BLUR_RADIUS[heatmapMode]);
    return { grid, cap: intensityCap(grid), total: raw.total };
  }, [mapTracks, visibleSlots, heatmapMode]);

  /**
   * The grid painted into a small offscreen canvas, scaled up at draw time.
   *
   * Split from the aggregation above so an intensity tweak only recolours 160x160 bins
   * rather than re-binning tens of thousands of points.
   */
  const heatmapCanvas = useMemo(() => {
    if (!heatmapStats || heatmapMode === 'none' || heatmapStats.cap <= 0) return null;
    const { grid, cap } = heatmapStats;
    const canvas = document.createElement('canvas');
    canvas.width = grid.resolution;
    canvas.height = grid.resolution;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const rgba = gridToRgba(grid, heatmapMode, cap, heatmapIntensity);
    ctx.putImageData(new ImageData(rgba, grid.resolution, grid.resolution), 0, 0);
    return canvas;
  }, [heatmapStats, heatmapMode, heatmapIntensity]);

  const match = selectedMatch !== null ? dataset?.matches[selectedMatch] : undefined;
  const duration = match?.durationSec ?? 0;
  // Playback only applies to a drilled-into match; the aggregate view has no shared clock.
  const playbackActive = match !== undefined;

  /**
   * Everything the draw call needs, held in a ref.
   *
   * The animation loop reads this instead of closing over React state, so the loop never
   * re-subscribes and the expensive memos above never recompute per frame.
   */
  const drawInputsRef = useRef<{
    options: Omit<RenderOptions, 'playbackTime'>;
    map: MapModel | null;
    image: HTMLImageElement | null;
    size: { width: number; height: number };
    dpr: number;
  } | null>(null);

  const drawFrame = useCallback((time: number | null) => {
    const canvas = canvasRef.current;
    const inputs = drawInputsRef.current;
    if (!canvas || !inputs || inputs.size.width === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(inputs.dpr, 0, 0, inputs.dpr, 0, 0);
    render(ctx, inputs.size, inputs.map, inputs.image, {
      ...inputs.options,
      playbackTime: time,
    });
  }, []);

  // Static draw: runs on any change to the scene, never per animation frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    resizeCanvasToDisplaySize(canvas, size, dpr);
    drawInputsRef.current = {
      options: {
        rect,
        tracks: mapTracks,
        visibleSlots,
        slotIsBot,
        selectedSlot,
        soloThreshold: PATH_READABILITY_LIMIT,
        eventGroups: eventVisibility,
        heatmap: heatmapCanvas,
        region: drag ? regionFromCanvasDrag(drag.start, drag.current, rect) : region,
      },
      map,
      image: image.current,
      size,
      dpr,
    };
    drawFrame(playbackActive ? playback.time : null);
  }, [
    size,
    rect,
    map,
    mapTracks,
    visibleSlots,
    slotIsBot,
    selectedSlot,
    eventVisibility,
    heatmapCanvas,
    region,
    drag,
    imageState,
    image,
    playbackActive,
    playback.time,
    drawFrame,
  ]);

  /**
   * The playback clock — the only use of requestAnimationFrame in the app.
   *
   * It advances a local time value and calls `drawFrame` directly, so the canvas updates
   * at display rate while React re-renders only when the UI readout needs to change
   * (about ten times a second). Without that split, a 60 Hz state update would re-run
   * every consumer of the store on every frame.
   */
  const timeRef = useRef(playback.time);
  useEffect(() => {
    timeRef.current = playback.time;
  }, [playback.time]);

  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (!playback.playing || !playbackActive || duration <= 0) return;

    let frame = 0;
    let previous = performance.now();
    let lastPublished = -1;

    const tick = (now: number) => {
      const deltaSeconds = Math.min(0.25, (now - previous) / 1000); // ignore tab-away jumps
      previous = now;

      const { time, ended } = advance(timeRef.current, deltaSeconds, playback.speed, duration);
      timeRef.current = time;
      drawFrame(time);

      // Publish to React at ~10 Hz, or immediately when playback ends.
      if (ended || now - lastPublished > 100) {
        lastPublished = now;
        dispatchRef.current({ type: 'playback/tick', time, ended });
      }
      if (!ended) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playback.playing, playback.speed, playbackActive, duration, drawFrame]);

  // Hover: resolve the marker under the pointer and feed the single tooltip element.
  // Event markers win over paths, matching what the eye picks out.
  const handleMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!mapTracks || !dataset) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    if (drag) {
      setDrag((previous) => (previous ? { ...previous, current: point } : previous));
      return;
    }
    const clip = playbackActive ? playback.time : null;
    const picked = pickEvent(mapTracks, rect, visibleSlots, eventVisibility, point, 7, clip);
    if (!picked) {
      setHover((previous) => (previous === null ? previous : null));
      return;
    }
    const journeyId = mapTracks.journeyIds[picked.slot];
    const journey = journeyId === undefined ? undefined : dataset.journeys[journeyId];
    if (!journey) return;
    setHover((previous) =>
      previous?.event.index === picked.index
        ? previous
        : { event: picked, journey, match: dataset.matches[journey.match] },
    );
  };

  // Click the map to select the nearest visible journey; click empty space to clear.
  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!mapTracks || event.shiftKey) return; // Shift+click is the tail end of a drag
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const clip = playbackActive ? playback.time : null;
    const slot = pickJourney(mapTracks, rect, visibleSlots, point, 10, clip);
    dispatch({
      type: 'journey/focus',
      journey: slot < 0 ? null : (mapTracks.journeyIds[slot] ?? null),
    });
  };

  const canvasPoint = (event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!event.shiftKey) return;
    event.preventDefault(); // avoid text-selection while dragging
    const point = canvasPoint(event);
    setDrag({ start: point, current: point });
  };

  const finishDrag = () => {
    if (!drag) return;
    const uvRect = regionFromCanvasDrag(drag.start, drag.current, rect);
    setDrag(null);
    if (uvRect) dispatch({ type: 'region/set', region: uvRect });
  };

  // Escape clears an active region — the same cheap-to-undo pattern as clearing filters.
  useEffect(() => {
    if (!region) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dispatch({ type: 'region/clear' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [region, dispatch]);

  const isLoadingTracks = tracksLoading !== null && tracksLoading === mapId;
  const isEmpty = !isLoadingTracks && mapTracks !== null && selection.journeyIds.length === 0;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-surface-0">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMove}
        onMouseUp={finishDrag}
        onMouseLeave={() => {
          setHover(null);
          finishDrag();
        }}
        className="block h-full w-full cursor-crosshair"
        aria-label="Map workspace"
      />

      <EventTooltip target={hover} container={size} />

      {imageState === 'failed' && <MapArtworkWarning />}
      {isLoadingTracks && (
        <TracksLoading
          mapName={map?.displayName ?? ''}
          journeys={map?.totals.journeys ?? 0}
        />
      )}
      {isEmpty && <EmptySelection />}
    </div>
  );
}
