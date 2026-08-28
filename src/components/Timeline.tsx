import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../store/editorStore";
import { clipDuration, clipEnd } from "../lib/timeline-math";
import { Scissors, Trash2, Plus, X } from "lucide-react";

const TRACK_HEIGHT = 56;
const RULER_HEIGHT = 24;

export function Timeline() {
  const tracks = useEditorStore((s) => s.tracks);
  const clips = useEditorStore((s) => s.clips);
  const zoom = useEditorStore((s) => s.zoom);
  const playhead = useEditorStore((s) => s.playhead);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const duration = useEditorStore((s) => s.duration());

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

  const timeToPx = (t: number) => t * zoom;
  const pxToTime = (px: number) => px / zoom;

  const totalWidth = Math.max(800, (duration + 10) * zoom);

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
    e.stopPropagation();
    seekFromClientX(e.clientX);
    setIsScrubbing(true);
  };

  const onClipMouseDown = (
    e: React.MouseEvent,
    clipId: string,
    mode: "move" | "trim-in" | "trim-out"
  ) => {
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

      if (drag.mode === "move") {
        const originalTrack = tracks.find((t) => t.id === clip.trackId);
        const hovered = trackIdAtClientY(e.clientY);
        const hoveredTrack = tracks.find((t) => t.id === hovered);
        const targetTrackId =
          hoveredTrack && originalTrack && hoveredTrack.kind === originalTrack.kind
            ? hoveredTrack.id
            : clip.trackId;
        setHoverTrackId(targetTrackId);
        moveClip(drag.clipId, clip.start + deltaT, targetTrackId);
      } else if (drag.mode === "trim-in") {
        trimClip(drag.clipId, "in", clip.start + deltaT);
      } else {
        trimClip(drag.clipId, "out", clip.start + clipDuration(clip) + deltaT);
      }
      setDrag((d) => (d ? { ...d, startX: e.clientX } : d));
    };

    const onUp = () => {
      setDrag(null);
      setIsScrubbing(false);
      setHoverTrackId(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, isScrubbing, clips, tracks, moveClip, trimClip, zoom]);

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
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { clipEnd };
