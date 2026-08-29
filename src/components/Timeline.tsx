import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../store/editorStore";
import {
  clipDuration,
  clipEnd,
  collectSnapPoints,
  getDeclaredCrossTrackOverlaps,
  getOverlaps,
  snapMoveStart,
  snapValue,
  transitionKey,
  TRANSITION_DND_TYPE,
  TRANSITION_LABELS,
  type Clip,
  type TransitionType,
} from "../lib/timeline-math";
import { Scissors, Trash2, Plus, X } from "lucide-react";

const TRACK_HEIGHT = 56;
const RULER_HEIGHT = 24;
const SNAP_PX = 8;
const DEFAULT_TRANSITION_OVERLAP = 0.5;
// Clips rarely end up touching at *exact* floating-point equality after a
// manual drag (only a fresh split guarantees that) - treat anything within
// this many timeline pixels as "adjacent" so the add-transition affordance
// is reliably discoverable, not just for pixel-perfect touches.
const ADJACENCY_GAP_PX = 10;

export function Timeline() {
  const tracks = useEditorStore((s) => s.tracks);
  const clips = useEditorStore((s) => s.clips);
  const zoom = useEditorStore((s) => s.zoom);
  const playhead = useEditorStore((s) => s.playhead);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const duration = useEditorStore((s) => s.duration());
  const transitionTypes = useEditorStore((s) => s.transitionTypes);
  const setTransitionType = useEditorStore((s) => s.setTransitionType);

  const addTrack = useEditorStore((s) => s.addTrack);
  const removeTrack = useEditorStore((s) => s.removeTrack);
  const addClipToTimeline = useEditorStore((s) => s.addClipToTimeline);
  const moveClip = useEditorStore((s) => s.moveClip);
  const trimClip = useEditorStore((s) => s.trimClip);
  const splitClipAtPlayhead = useEditorStore((s) => s.splitClipAtPlayhead);
  const removeClip = useEditorStore((s) => s.removeClip);
  const selectClip = useEditorStore((s) => s.selectClip);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);

  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    clipId: string;
    mode: "move" | "trim-in" | "trim-out";
    startX: number;
  } | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [hoverTrackId, setHoverTrackId] = useState<string | null>(null);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const timeToPx = (t: number) => t * zoom;
  const pxToTime = (px: number) => px / zoom;

  const totalWidth = Math.max(800, (duration + 10) * zoom);
  const overlaps = getOverlaps(clips, tracks);

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

  const crossTrackOverlaps = getDeclaredCrossTrackOverlaps(clips, tracks, transitionTypes);

  // Closes the gap (if any) between prevClipId and nextClipId down to a
  // consistent DEFAULT_TRANSITION_OVERLAP-sized overlap, regardless of how
  // large the pre-existing gap was.
  const createOverlap = (prevClipId: string, nextClipId: string) => {
    const prevClip = clips.find((c) => c.id === prevClipId);
    if (!prevClip) return;
    moveClip(nextClipId, clipEnd(prevClip) - DEFAULT_TRANSITION_OVERLAP);
  };

  const addTransition = (prevClipId: string, nextClipId: string) => {
    createOverlap(prevClipId, nextClipId);
    setTransitionType(prevClipId, nextClipId, "crossfade");
  };

  const onBoundaryDrop = (e: React.DragEvent, prevClipId: string, nextClipId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverKey(null);
    const type = e.dataTransfer.getData(TRANSITION_DND_TYPE) as TransitionType;
    if (!type) return;
    createOverlap(prevClipId, nextClipId);
    setTransitionType(prevClipId, nextClipId, type);
  };

  const onOverlapDrop = (e: React.DragEvent, prevClipId: string, nextClipId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverKey(null);
    const type = e.dataTransfer.getData(TRANSITION_DND_TYPE) as TransitionType;
    if (!type) return;
    setTransitionType(prevClipId, nextClipId, type);
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
    setDrag({ clipId, mode, startX: e.clientX });
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
      const deltaPx = e.clientX - drag.startX;
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

        const duration = clipDuration(clip);
        const rawStart = clip.start + deltaT;
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
        const rawTime = clip.start + deltaT;
        const snapped = snapValue(rawTime, snapPoints, snapThreshold);
        setSnapGuide(snapped !== rawTime ? snapped : null);
        trimClip(drag.clipId, "in", snapped);
      } else {
        const rawTime = clip.start + clipDuration(clip) + deltaT;
        const snapped = snapValue(rawTime, snapPoints, snapThreshold);
        setSnapGuide(snapped !== rawTime ? snapped : null);
        trimClip(drag.clipId, "out", snapped);
      }
      setDrag((d) => (d ? { ...d, startX: e.clientX } : d));
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

  const onTrackDrop = (e: React.DragEvent, trackId: string) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData("application/x-source-id");
    if (!sourceId) return;
    const rect = containerRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left + containerRef.current!.scrollLeft;
    addClipToTimeline(sourceId, trackId, Math.max(0, pxToTime(x)));
  };

  return (
    <div className="timeline">
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
          disabled={!selectedClipId}
          onClick={() => selectedClipId && removeClip(selectedClipId)}
          title="Delete clip (Del)"
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
        <span className="timeline-time">{playhead.toFixed(2)}s</span>
      </div>

      <div className="timeline-scroll" ref={containerRef}>
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
                    <div
                      className="clip-handle clip-handle-right"
                      onMouseDown={(e) => onClipMouseDown(e, clip.id, "trim-out")}
                    />
                  </div>
                ))}
              {[...overlaps.map((o) => ({ ...o, crossTrack: false })), ...crossTrackOverlaps.map((o) => ({ ...o, crossTrack: true }))]
                .filter((o) => o.trackId === track.id)
                .map((o) => {
                  const key = transitionKey(o.prevClip.id, o.nextClip.id);
                  const type = transitionTypes[key] ?? "crossfade";
                  return (
                    <div
                      key={key}
                      className={`timeline-transition ${o.crossTrack ? "cross-track" : ""} ${dragOverKey === key ? "drag-over" : ""}`}
                      style={{ left: timeToPx(o.start), width: Math.max(4, timeToPx(o.duration)) }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOverKey(key);
                      }}
                      onDragLeave={() => setDragOverKey((k) => (k === key ? null : k))}
                      onDrop={(e) => onOverlapDrop(e, o.prevClip.id, o.nextClip.id)}
                      title={`${TRANSITION_LABELS[type]} (${o.duration.toFixed(2)}s)${o.crossTrack ? " - cross-track" : ""}`}
                    >
                      <div
                        className="transition-handle transition-handle-left"
                        title="Drag to shorten/lengthen the transition"
                        onMouseDown={(e) => onClipMouseDown(e, o.nextClip.id, "trim-in")}
                      />
                      <span className="timeline-transition-label">
                        {TRANSITION_LABELS[type]}
                        {o.crossTrack ? " ⇄" : ""}
                      </span>
                      <div
                        className="transition-handle transition-handle-right"
                        title="Drag to shorten/lengthen the transition"
                        onMouseDown={(e) => onClipMouseDown(e, o.prevClip.id, "trim-out")}
                      />
                      <select
                        className="timeline-transition-select"
                        value={type}
                        onChange={(e) =>
                          setTransitionType(
                            o.prevClip.id,
                            o.nextClip.id,
                            e.target.value as TransitionType
                          )
                        }
                      >
                        {Object.entries(TRANSITION_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              {adjacentPairs
                .filter((p) => p.trackId === track.id)
                .map((p) => {
                  const key = `${p.prevClip.id}->${p.nextClip.id}`;
                  return (
                    <button
                      key={key}
                      className={`add-transition-btn ${p.crossTrack ? "cross-track" : ""} ${dragOverKey === key ? "drag-over" : ""}`}
                      style={{ left: timeToPx((clipEnd(p.prevClip) + p.nextClip.start) / 2) }}
                      title={
                        p.crossTrack
                          ? "Add cross-track transition (click for crossfade, or drag one here)"
                          : "Add transition (click for crossfade, or drag one here)"
                      }
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        addTransition(p.prevClip.id, p.nextClip.id);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOverKey(key);
                      }}
                      onDragLeave={() => setDragOverKey((k) => (k === key ? null : k))}
                      onDrop={(e) => onBoundaryDrop(e, p.prevClip.id, p.nextClip.id)}
                    >
                      <Plus size={10} />
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { clipEnd };
