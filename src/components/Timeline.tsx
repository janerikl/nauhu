import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent } from "react";
import { useEditorStore } from "../store/editorStore";
import {
  clipDuration,
  clipEnd,
  collectSnapPoints,
  snapMoveStart,
  snapValue,
  TRANSITION_DND_TYPE,
  TRANSITION_LABELS,
  type Clip,
  type TransitionType,
} from "../lib/timeline-math";
import { Scissors, Trash2, Plus, X, ZoomIn, ZoomOut } from "lucide-react";
import { Waveform } from "./Waveform";
import { Filmstrip } from "./Filmstrip";

const TRACK_HEIGHT = 106;
const RULER_HEIGHT = 24;
const SNAP_PX = 8;
const DEFAULT_TRANSITION_OVERLAP = 1.0;
const MIN_TRANSITION_DURATION = 0.1;
/** How far (px) a transition block must be dragged vertically off its track before releasing deletes it. */
const DELETE_DRAG_THRESHOLD_PX = TRACK_HEIGHT;
// Clips rarely end up touching at *exact* floating-point equality after a
// manual drag (only a fresh split guarantees that) - treat anything within
// this many timeline pixels as "adjacent" so the add-transition affordance
// is reliably discoverable, not just for pixel-perfect touches.
const ADJACENCY_GAP_PX = 10;

export function Timeline() {
  const tracks = useEditorStore((s) => s.tracks);
  const clips = useEditorStore((s) => s.clips);
  const sources = useEditorStore((s) => s.sources);
  const zoom = useEditorStore((s) => s.zoom);
  const playhead = useEditorStore((s) => s.playhead);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const selectedTransitionId = useEditorStore((s) => s.selectedTransitionId);
  const duration = useEditorStore((s) => s.duration());
  const transitions = useEditorStore((s) => s.transitions);
  const addTransition = useEditorStore((s) => s.addTransition);
  const updateTransition = useEditorStore((s) => s.updateTransition);
  const removeTransition = useEditorStore((s) => s.removeTransition);
  const selectTransition = useEditorStore((s) => s.selectTransition);

  const addTrack = useEditorStore((s) => s.addTrack);
  const removeTrack = useEditorStore((s) => s.removeTrack);
  const addClipToTimeline = useEditorStore((s) => s.addClipToTimeline);
  const addTextClip = useEditorStore((s) => s.addTextClip);
  const updateClip = useEditorStore((s) => s.updateClip);
  const moveClip = useEditorStore((s) => s.moveClip);
  const trimClip = useEditorStore((s) => s.trimClip);
  const splitClipAtPlayhead = useEditorStore((s) => s.splitClipAtPlayhead);
  const removeClip = useEditorStore((s) => s.removeClip);
  const selectClip = useEditorStore((s) => s.selectClip);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setZoom = useEditorStore((s) => s.setZoom);

  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    clipId: string;
    mode: "move" | "trim-in" | "trim-out";
    originX: number;
    originStart: number;
    originDuration: number;
  } | null>(null);
  const [transitionDrag, setTransitionDrag] = useState<{
    id: string;
    mode: "move" | "resize-left" | "resize-right";
    originX: number;
    originY: number;
    originStart: number;
    originDuration: number;
  } | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [hoverTrackId, setHoverTrackId] = useState<string | null>(null);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const MIN_TIMELINE_HEIGHT = 140;
  const MAX_TIMELINE_HEIGHT = Math.round(window.innerHeight * 0.8);
  const [timelineHeight, setTimelineHeight] = useState(() => {
    const stored = Number(localStorage.getItem("timelineHeight"));
    if (Number.isFinite(stored) && stored >= MIN_TIMELINE_HEIGHT) return stored;
    return 260;
  });
  const heightDragRef = useRef<{ originY: number; originHeight: number } | null>(null);

  const onHeightHandleMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    heightDragRef.current = { originY: e.clientY, originHeight: timelineHeight };
    const onMouseMove = (ev: MouseEvent) => {
      const origin = heightDragRef.current;
      if (!origin) return;
      const delta = origin.originY - ev.clientY;
      const next = Math.min(
        MAX_TIMELINE_HEIGHT,
        Math.max(MIN_TIMELINE_HEIGHT, origin.originHeight + delta)
      );
      setTimelineHeight(next);
    };
    const onMouseUp = () => {
      heightDragRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  useEffect(() => {
    localStorage.setItem("timelineHeight", String(timelineHeight));
  }, [timelineHeight]);

  const timeToPx = (t: number) => t * zoom;
  const pxToTime = (px: number) => px / zoom;

  const totalWidth = Math.max(800, (duration + 10) * zoom);

  // Pairs of time-adjacent (touching or nearly-touching, not yet overlapping)
  // clips on the same track - each is a candidate boundary where a
  // transition can be added. A pixel-based threshold (rather than requiring
  // exact floating-point touching) is used because a manually dragged clip
  // almost never lands at *exactly* the neighbor's edge.
  const adjacencyThreshold = pxToTime(ADJACENCY_GAP_PX);
  type AdjacentPair = { trackId: string; prevClip: Clip; nextClip: Clip; crossTrack: boolean };
  const adjacentPairs: AdjacentPair[] = tracks.flatMap((track) => {
    const onTrack = clips.filter((c) => c.trackId === track.id).sort((a, b) => a.start - b.start);
    const pairs: AdjacentPair[] = [];
    for (let i = 0; i < onTrack.length - 1; i++) {
      const prevClip = onTrack[i];
      const nextClip = onTrack[i + 1];
      const gap = nextClip.start - clipEnd(prevClip);
      if (gap >= 0 && gap < adjacencyThreshold) {
        pairs.push({ trackId: track.id, prevClip, nextClip, crossTrack: false });
      }
    }
    return pairs;
  });

  // Same adjacency check, but across every pair of distinct video tracks -
  // lets a transition be started even when the two clips live on separate
  // lanes (e.g. one clip per track, common when clips were split across
  // tracks for editing convenience).
  const videoTracks = tracks.filter((t) => t.kind === "video");
  for (const trackA of videoTracks) {
    for (const trackB of videoTracks) {
      if (trackA.id === trackB.id) continue;
      const clipsA = clips.filter((c) => c.trackId === trackA.id);
      const clipsB = clips.filter((c) => c.trackId === trackB.id);
      for (const a of clipsA) {
        for (const b of clipsB) {
          const gap = b.start - clipEnd(a);
          if (gap >= 0 && gap < adjacencyThreshold) {
            adjacentPairs.push({ trackId: trackB.id, prevClip: a, nextClip: b, crossTrack: true });
          }
        }
      }
    }
  }

  // Only offer to create a transition at a boundary that doesn't already
  // have one - once decoupled, a pair of clips can be adjacent without any
  // relation to a transition that was placed elsewhere on the timeline.
  const hasTransitionFor = (prevClipId: string, nextClipId: string) =>
    transitions.some((t) => t.prevClipId === prevClipId && t.nextClipId === nextClipId);

  // The last clip on each video track - the only place a fade-to-black at a
  // clip's own tail makes sense, since anywhere else there's a following
  // clip to transition into instead (handled by the two-clip Transition
  // model above).
  const lastClipByTrack = new Map<string, Clip>();
  for (const track of tracks) {
    if (track.kind !== "video") continue;
    const onTrack = clips.filter((c) => c.trackId === track.id);
    if (onTrack.length === 0) continue;
    lastClipByTrack.set(
      track.id,
      onTrack.reduce((a, b) => (clipEnd(b) > clipEnd(a) ? b : a))
    );
  }

  // Dropping "Fade to black" on a clip's own tail sets a per-clip fade-out
  // (see Clip.fadeOutBlack) rather than creating a two-clip Transition -
  // there's no incoming clip to blend with at the end of the timeline.
  const onTailDrop = (e: React.DragEvent, clipId: string, maxDuration: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverKey(null);
    const type = e.dataTransfer.getData(TRANSITION_DND_TYPE) as TransitionType;
    if (type !== "fadeToBlack") return;
    useEditorStore.getState().pushHistory();
    updateClip(clipId, { fadeOutBlack: Math.min(DEFAULT_TRANSITION_OVERLAP, maxDuration) });
  };

  // Dropping a transition on a clip boundary both nudges the two clips into
  // a real DEFAULT_TRANSITION_OVERLAP-sized overlap (so the effect is born
  // "active") and creates an independent transition record at that spot.
  const onBoundaryDrop = (e: React.DragEvent, prevClipId: string, nextClipId: string, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverKey(null);
    const type = e.dataTransfer.getData(TRANSITION_DND_TYPE) as TransitionType;
    if (!type) return;
    const prevClip = clips.find((c) => c.id === prevClipId);
    if (!prevClip) return;
    const start = clipEnd(prevClip) - DEFAULT_TRANSITION_OVERLAP;
    useEditorStore.getState().pushHistory();
    moveClip(nextClipId, start);
    addTransition({ trackId, prevClipId, nextClipId, start, duration: DEFAULT_TRANSITION_OVERLAP, type });
  };

  const onTransitionTypeDrop = (e: React.DragEvent, transitionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverKey(null);
    const type = e.dataTransfer.getData(TRANSITION_DND_TYPE) as TransitionType;
    if (!type) return;
    useEditorStore.getState().pushHistory();
    updateTransition(transitionId, { type });
  };

  const seekFromClientX = (clientX: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const x = clientX - rect.left + containerRef.current!.scrollLeft;
    setPlayhead(Math.max(0, pxToTime(x)));
  };

  const trackIdAtClientY = (clientY: number): string | null => {
    const rect = containerRef.current!.getBoundingClientRect();
    const y = clientY - rect.top + containerRef.current!.scrollTop;
    const index = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
    return tracks[index]?.id ?? null;
  };

  const startScrub = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    seekFromClientX(e.clientX);
    setIsScrubbing(true);
  };

  const onClipMouseDown = (
    e: React.MouseEvent,
    clipId: string,
    mode: "move" | "trim-in" | "trim-out"
  ) => {
    e.preventDefault(); // avoid native text-selection drag when starting on the clip label
    e.stopPropagation();
    selectClip(clipId);
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    useEditorStore.getState().pushHistory();
    setDrag({
      clipId,
      mode,
      originX: e.clientX,
      originStart: clip.start,
      originDuration: clipDuration(clip),
    });
  };

  // Attach drag/scrub listeners to the window (not just the timeline element)
  // so a mouseup or mousemove that lands outside the timeline while dragging
  // fast still ends the drag, instead of leaving it stuck.
  useEffect(() => {
    if (!drag && !isScrubbing) return;

    const onMove = (e: MouseEvent) => {
      if (isScrubbing) {
        seekFromClientX(e.clientX);
        return;
      }
      if (!drag) return;
      // Deltas are measured from the fixed mousedown origin (not the last
      // moved-to position) so that snapping to a point (e.g. the playhead)
      // never "traps" the drag - a snap only affects where the clip lands,
      // it never resets what counts as the start of the gesture, so
      // continuing to move the mouse further always keeps making progress.
      const deltaPx = e.clientX - drag.originX;
      const deltaT = pxToTime(deltaPx);
      const clip = clips.find((c) => c.id === drag.clipId);
      if (!clip) return;

      const snapThreshold = pxToTime(SNAP_PX);
      const snapPoints = collectSnapPoints(clips, drag.clipId, [0, playhead]);

      if (drag.mode === "move") {
        const originalTrack = tracks.find((t) => t.id === clip.trackId);
        const hovered = trackIdAtClientY(e.clientY);
        const hoveredTrack = tracks.find((t) => t.id === hovered);
        const targetTrackId =
          hoveredTrack && originalTrack && hoveredTrack.kind === originalTrack.kind
            ? hoveredTrack.id
            : clip.trackId;
        setHoverTrackId(targetTrackId);

        const duration = drag.originDuration;
        const rawStart = drag.originStart + deltaT;
        const snappedStart = snapMoveStart(rawStart, duration, snapPoints, snapThreshold);
        setSnapGuide(
          snappedStart !== rawStart
            ? snapPoints.find(
                (p) => Math.abs(p - snappedStart) < 1e-6 || Math.abs(p - (snappedStart + duration)) < 1e-6
              ) ?? null
            : null
        );
        moveClip(drag.clipId, snappedStart, targetTrackId);
      } else if (drag.mode === "trim-in") {
        const rawTime = drag.originStart + deltaT;
        const snapped = snapValue(rawTime, snapPoints, snapThreshold);
        setSnapGuide(snapped !== rawTime ? snapped : null);
        trimClip(drag.clipId, "in", snapped);
      } else {
        const rawTime = drag.originStart + drag.originDuration + deltaT;
        const snapped = snapValue(rawTime, snapPoints, snapThreshold);
        setSnapGuide(snapped !== rawTime ? snapped : null);
        trimClip(drag.clipId, "out", snapped);
      }
    };

    const onUp = () => {
      setDrag(null);
      setIsScrubbing(false);
      setHoverTrackId(null);
      setSnapGuide(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, isScrubbing, clips, tracks, playhead, moveClip, trimClip, zoom]);

  // Show a grabbing/resizing cursor across the whole page while a drag is in
  // progress, since the mouse is often not directly over the clip anymore.
  useEffect(() => {
    if (!drag) return;
    document.body.style.cursor = drag.mode === "move" ? "grabbing" : "ew-resize";
    return () => {
      document.body.style.cursor = "";
    };
  }, [drag]);

  // A transition block is a fully independent object now: dragging its body
  // slides its own start (unrelated to the clips underneath), and dragging
  // an edge resizes its own duration - neither touches the referenced
  // clips' trim points. Dragging the body far enough off its track
  // vertically and releasing deletes it.
  useEffect(() => {
    if (!transitionDrag) return;

    const onMove = (e: MouseEvent) => {
      const deltaT = pxToTime(e.clientX - transitionDrag.originX);
      const { id, mode, originStart, originDuration } = transitionDrag;

      if (mode === "move") {
        updateTransition(id, { start: originStart + deltaT });
      } else if (mode === "resize-left") {
        const maxStart = originStart + originDuration - MIN_TRANSITION_DURATION;
        const newStart = Math.min(maxStart, originStart + deltaT);
        updateTransition(id, { start: newStart, duration: originStart + originDuration - newStart });
      } else {
        const newDuration = Math.max(MIN_TRANSITION_DURATION, originDuration + deltaT);
        updateTransition(id, { duration: newDuration });
      }
    };

    const onUp = (e: MouseEvent) => {
      if (transitionDrag.mode === "move" && Math.abs(e.clientY - transitionDrag.originY) > DELETE_DRAG_THRESHOLD_PX) {
        removeTransition(transitionDrag.id);
      }
      setTransitionDrag(null);
    };

    document.body.style.cursor = transitionDrag.mode === "move" ? "grabbing" : "ew-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transitionDrag, updateTransition, removeTransition, zoom]);

  const onTrackDrop = (e: React.DragEvent, trackId: string) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData("application/x-source-id");
    if (!sourceId) return;
    const rect = containerRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left + containerRef.current!.scrollLeft;
    addClipToTimeline(sourceId, trackId, Math.max(0, pxToTime(x)));
  };

  const onWheelZoom = (e: WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  };

  return (
    <div className="timeline" style={{ height: timelineHeight }}>
      <div className="timeline-resize-handle" onMouseDown={onHeightHandleMouseDown} />
      <div className="timeline-toolbar">
        <button
          className="btn-icon"
          disabled={!selectedClipId}
          onClick={() => selectedClipId && splitClipAtPlayhead(selectedClipId)}
          title="Split at playhead (S)"
        >
          <Scissors size={14} />
        </button>
        <button
          className="btn-icon"
          disabled={!selectedClipId && !selectedTransitionId}
          onClick={() => {
            if (selectedClipId) removeClip(selectedClipId);
            else if (selectedTransitionId) removeTransition(selectedTransitionId);
          }}
          title="Delete clip or transition (Del)"
        >
          <Trash2 size={14} />
        </button>
        <span className="timeline-divider" />
        <button className="btn-icon" onClick={() => addTrack("video")} title="Add video track">
          <Plus size={14} /> Video
        </button>
        <button className="btn-icon" onClick={() => addTrack("audio")} title="Add audio track">
          <Plus size={14} /> Audio
        </button>
        <button
          className="btn-icon"
          onClick={() => {
            const trackId = addTrack("text");
            addTextClip(trackId, playhead);
          }}
          title="Add text track"
        >
          <Plus size={14} /> Text
        </button>
        <span className="timeline-divider" />
        <button
          className="btn-icon"
          onClick={() => setZoom(zoom / 1.25)}
          title="Zoom out timeline"
        >
          <ZoomOut size={14} />
        </button>
        <button
          className="btn-icon"
          onClick={() => setZoom(zoom * 1.25)}
          title="Zoom in timeline"
        >
          <ZoomIn size={14} />
        </button>
        <span className="timeline-time">{playhead.toFixed(2)}s</span>
      </div>

      <div className="timeline-scroll" ref={containerRef} onWheel={onWheelZoom}>
        <div className="timeline-inner" style={{ width: totalWidth }}>
          <div className="timeline-ruler" style={{ height: RULER_HEIGHT }} onMouseDown={startScrub}>
            {Array.from({ length: Math.ceil(totalWidth / zoom) }).map((_, i) => (
              <div key={i} className="ruler-tick" style={{ left: i * zoom }}>
                {i}s
              </div>
            ))}
          </div>

          <div
            className="playhead"
            style={{ left: timeToPx(playhead), height: tracks.length * TRACK_HEIGHT + RULER_HEIGHT }}
          >
            <div className="playhead-handle" onMouseDown={startScrub} />
          </div>

          {snapGuide !== null && (
            <div
              className="snap-guide"
              style={{ left: timeToPx(snapGuide), height: tracks.length * TRACK_HEIGHT + RULER_HEIGHT }}
            />
          )}

          {tracks.map((track) => (
            <div
              key={track.id}
              className={`timeline-track track-${track.kind} ${hoverTrackId === track.id ? "drop-target" : ""}`}
              style={{ height: TRACK_HEIGHT }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onTrackDrop(e, track.id)}
              onDoubleClick={(e) => {
                if (track.kind !== "text" || e.target !== e.currentTarget) return;
                const rect = containerRef.current!.getBoundingClientRect();
                const x = e.clientX - rect.left + containerRef.current!.scrollLeft;
                addTextClip(track.id, Math.max(0, pxToTime(x)));
              }}
            >
              <div className="track-label">
                <span>{track.name}</span>
                <button
                  className="track-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTrack(track.id);
                  }}
                  title="Remove track"
                >
                  <X size={10} />
                </button>
              </div>
              {clips
                .filter((c) => c.trackId === track.id)
                .map((clip) => (
                  <div
                    key={clip.id}
                    className={[
                      "timeline-clip",
                      selectedClipId === clip.id ? "selected" : "",
                      drag?.clipId === clip.id && drag.mode === "move" ? "dragging" : "",
                      drag?.clipId === clip.id && drag.mode !== "move" ? "trimming" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{
                      left: timeToPx(clip.start),
                      width: Math.max(4, timeToPx(clip.start + clipDuration(clip)) - timeToPx(clip.start)),
                      background: clip.color,
                    }}
                    onMouseDown={(e) => onClipMouseDown(e, clip.id, "move")}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectClip(clip.id);
                    }}
                  >
                    <div
                      className="clip-handle clip-handle-left"
                      onMouseDown={(e) => onClipMouseDown(e, clip.id, "trim-in")}
                    />
                    <span className="clip-label">{clip.sourceName}</span>
                    {(() => {
                      const source = sources.find((s) => s.id === clip.sourceId);
                      // Gate on the track, not the source's own kind: a clip
                      // on the audio track can point at a video source (its
                      // audio split out via mutedVideo) and still has
                      // decodable audio worth drawing a waveform for.
                      if (!source) return null;
                      const clipWidth =
                        timeToPx(clip.start + clipDuration(clip)) - timeToPx(clip.start);
                      if (track.kind === "audio") {
                        return (
                          <Waveform
                            sourceId={source.id}
                            blob={source.blob}
                            sourceIn={clip.sourceIn}
                            sourceOut={clip.sourceOut}
                            width={Math.max(4, clipWidth)}
                            height={TRACK_HEIGHT - 8}
                          />
                        );
                      }
                      if (track.kind === "video" && (source.kind === "video" || source.kind === "image")) {
                        return (
                          <Filmstrip
                            sourceId={source.id}
                            url={source.url}
                            kind={source.kind}
                            sourceIn={clip.sourceIn}
                            sourceOut={clip.sourceOut}
                            width={Math.max(4, clipWidth)}
                            height={TRACK_HEIGHT - 8}
                          />
                        );
                      }
                      return null;
                    })()}
                    <div
                      className="clip-handle clip-handle-right"
                      onMouseDown={(e) => onClipMouseDown(e, clip.id, "trim-out")}
                    />
                  </div>
                ))}
              {transitions
                .filter((t) => t.trackId === track.id)
                .map((t) => {
                  const prevClip = clips.find((c) => c.id === t.prevClipId);
                  const nextClip = clips.find((c) => c.id === t.nextClipId);
                  if (!prevClip || !nextClip) return null;
                  const crossTrack = prevClip.trackId !== nextClip.trackId;
                  // "Active" means the two referenced clips genuinely overlap
                  // in time right now, so the effect actually has something
                  // to blend during playback - independent of where this
                  // block currently sits, which the user can freely move.
                  const isActive = clipEnd(prevClip) > nextClip.start;
                  return (
                    <div
                      key={t.id}
                      className={`timeline-transition ${crossTrack ? "cross-track" : ""} ${isActive ? "" : "inactive"} ${selectedTransitionId === t.id ? "selected" : ""} ${dragOverKey === t.id ? "drag-over" : ""}`}
                      style={{ left: timeToPx(t.start), width: Math.max(4, timeToPx(t.duration)) }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        selectTransition(t.id);
                        useEditorStore.getState().pushHistory();
                        setTransitionDrag({
                          id: t.id,
                          mode: "move",
                          originX: e.clientX,
                          originY: e.clientY,
                          originStart: t.start,
                          originDuration: t.duration,
                        });
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOverKey(t.id);
                      }}
                      onDragLeave={() => setDragOverKey((k) => (k === t.id ? null : k))}
                      onDrop={(e) => onTransitionTypeDrop(e, t.id)}
                      title={`${TRANSITION_LABELS[t.type]} (${t.duration.toFixed(2)}s)${isActive ? "" : " - inactive, clips no longer overlap"} - drag to reposition, drag off the track to delete, drag a transition from the panel to change type${crossTrack ? " - cross-track" : ""}`}
                    >
                      <div
                        className="transition-handle transition-handle-left"
                        title="Drag to shorten/lengthen the transition"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          selectTransition(t.id);
                          useEditorStore.getState().pushHistory();
                          setTransitionDrag({
                            id: t.id,
                            mode: "resize-left",
                            originX: e.clientX,
                            originY: e.clientY,
                            originStart: t.start,
                            originDuration: t.duration,
                          });
                        }}
                      />
                      <span className="timeline-transition-label">
                        {TRANSITION_LABELS[t.type]}
                        {crossTrack ? " ⇄" : ""}
                      </span>
                      <div
                        className="transition-handle transition-handle-right"
                        title="Drag to shorten/lengthen the transition"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          selectTransition(t.id);
                          useEditorStore.getState().pushHistory();
                          setTransitionDrag({
                            id: t.id,
                            mode: "resize-right",
                            originX: e.clientX,
                            originY: e.clientY,
                            originStart: t.start,
                            originDuration: t.duration,
                          });
                        }}
                      />
                    </div>
                  );
                })}
              {adjacentPairs
                .filter((p) => p.trackId === track.id && !hasTransitionFor(p.prevClip.id, p.nextClip.id))
                .map((p) => {
                  const key = `${p.prevClip.id}->${p.nextClip.id}`;
                  const center = (clipEnd(p.prevClip) + p.nextClip.start) / 2;
                  const dropZoneStart = center - DEFAULT_TRANSITION_OVERLAP / 2;
                  return (
                    <div
                      key={key}
                      className={`add-transition-zone ${p.crossTrack ? "cross-track" : ""} ${dragOverKey === key ? "drag-over" : ""}`}
                      style={{
                        left: timeToPx(dropZoneStart),
                        width: Math.max(4, timeToPx(DEFAULT_TRANSITION_OVERLAP)),
                      }}
                      title="Drag a transition here from the Transitions panel"
                      onMouseDown={(e) => e.stopPropagation()}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOverKey(key);
                      }}
                      onDragLeave={() => setDragOverKey((k) => (k === key ? null : k))}
                      onDrop={(e) => onBoundaryDrop(e, p.prevClip.id, p.nextClip.id, p.trackId)}
                    />
                  );
                })}
              {(() => {
                const lastClip = lastClipByTrack.get(track.id);
                if (!lastClip) return null;
                const key = `tail-fade-${lastClip.id}`;
                if (lastClip.fadeOutBlack) {
                  const fadeStart = clipEnd(lastClip) - lastClip.fadeOutBlack;
                  return (
                    <div
                      key={key}
                      className="timeline-transition tail-fade"
                      style={{ left: timeToPx(fadeStart), width: Math.max(4, timeToPx(lastClip.fadeOutBlack)) }}
                      onMouseDown={(e) => e.stopPropagation()}
                      title={`Fade to black (${lastClip.fadeOutBlack.toFixed(2)}s)`}
                    >
                      <span className="timeline-transition-label">Fade to black</span>
                      <button
                        className="track-remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          useEditorStore.getState().pushHistory();
                          updateClip(lastClip.id, { fadeOutBlack: undefined });
                        }}
                        title="Remove fade to black"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  );
                }
                const zoneDuration = Math.min(DEFAULT_TRANSITION_OVERLAP, clipDuration(lastClip));
                const zoneStart = clipEnd(lastClip) - zoneDuration;
                return (
                  <div
                    key={key}
                    className={`add-transition-zone tail-fade-zone ${dragOverKey === key ? "drag-over" : ""}`}
                    style={{ left: timeToPx(zoneStart), width: Math.max(4, timeToPx(zoneDuration)) }}
                    title="Drag 'Fade to black' here to fade out at the end"
                    onMouseDown={(e) => e.stopPropagation()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverKey(key);
                    }}
                    onDragLeave={() => setDragOverKey((k) => (k === key ? null : k))}
                    onDrop={(e) => onTailDrop(e, lastClip.id, zoneDuration)}
                  />
                );
              })()}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { clipEnd };
