import { useCallback, useRef, useState } from "react";
import { useEditorStore } from "../store/editorStore";
import { clipDuration, clipEnd } from "../lib/timeline-math";
import { Scissors, Trash2 } from "lucide-react";

const TRACK_HEIGHT = 56;
const RULER_HEIGHT = 24;

export function Timeline() {
  const tracks = useEditorStore((s) => s.tracks);
  const clips = useEditorStore((s) => s.clips);
  const zoom = useEditorStore((s) => s.zoom);
  const playhead = useEditorStore((s) => s.playhead);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const duration = useEditorStore((s) => s.duration());

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
    origStart: number;
  } | null>(null);

  const timeToPx = (t: number) => t * zoom;
  const pxToTime = (px: number) => px / zoom;

  const totalWidth = Math.max(800, (duration + 10) * zoom);

  const handleRulerClick = (e: React.MouseEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left + containerRef.current!.scrollLeft;
    setPlayhead(pxToTime(x));
  };

  const onClipMouseDown = (
    e: React.MouseEvent,
    clipId: string,
    mode: "move" | "trim-in" | "trim-out"
  ) => {
    e.stopPropagation();
    selectClip(clipId);
    setDrag({ clipId, mode, startX: e.clientX, origStart: 0 });
  };

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!drag) return;
      const deltaPx = e.clientX - drag.startX;
      const deltaT = pxToTime(deltaPx);
      const clip = clips.find((c) => c.id === drag.clipId);
      if (!clip) return;

      if (drag.mode === "move") {
        moveClip(drag.clipId, clip.start + deltaT);
      } else if (drag.mode === "trim-in") {
        trimClip(drag.clipId, "in", clip.start + deltaT);
      } else {
        trimClip(drag.clipId, "out", clip.start + clipDuration(clip) + deltaT);
      }
      setDrag({ ...drag, startX: e.clientX });
    },
    [drag, clips, moveClip, trimClip, zoom]
  );

  const handleMouseUp = () => setDrag(null);

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
        <span className="timeline-time">{playhead.toFixed(2)}s</span>
      </div>

      <div
        className="timeline-scroll"
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div className="timeline-inner" style={{ width: totalWidth }}>
          <div className="timeline-ruler" style={{ height: RULER_HEIGHT }} onClick={handleRulerClick}>
            {Array.from({ length: Math.ceil(totalWidth / zoom) }).map((_, i) => (
              <div key={i} className="ruler-tick" style={{ left: i * zoom }}>
                {i}s
              </div>
            ))}
          </div>

          <div
            className="playhead"
            style={{ left: timeToPx(playhead), height: tracks.length * TRACK_HEIGHT + RULER_HEIGHT }}
          />

          {tracks.map((track) => (
            <div
              key={track.id}
              className={`timeline-track track-${track.kind}`}
              style={{ height: TRACK_HEIGHT }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onTrackDrop(e, track.id)}
            >
              <div className="track-label">{track.name}</div>
              {clips
                .filter((c) => c.trackId === track.id)
                .map((clip) => (
                  <div
                    key={clip.id}
                    className={`timeline-clip ${selectedClipId === clip.id ? "selected" : ""}`}
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
