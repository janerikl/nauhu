import { useEffect, useRef } from "react";
import { useEditorStore } from "../store/editorStore";
import { clipEnd, findClipAt } from "../lib/timeline-math";
import { Play, Pause } from "lucide-react";

export function Preview() {
  const clips = useEditorStore((s) => s.clips);
  const sources = useEditorStore((s) => s.sources);
  const playhead = useEditorStore((s) => s.playhead);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setIsPlaying = useEditorStore((s) => s.setIsPlaying);
  const duration = useEditorStore((s) => s.duration());

  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const activeClipIdRef = useRef<string | null>(null);

  const videoTrackId = "video-1";
  const activeClip = findClipAt(clips, videoTrackId, playhead);
  const activeSource = activeClip ? sources.find((s) => s.id === activeClip.sourceId) : undefined;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip || !activeSource) return;
    const clipLocalTime = activeClip.sourceIn + (playhead - activeClip.start);

    if (activeClipIdRef.current !== activeClip.id) {
      video.src = activeSource.url;
      activeClipIdRef.current = activeClip.id;
      video.currentTime = clipLocalTime;
    } else if (Math.abs(video.currentTime - clipLocalTime) > 0.25) {
      video.currentTime = clipLocalTime;
    }
  }, [activeClip?.id, activeSource?.url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) video.play().catch(() => {});
    else video.pause();
  }, [isPlaying, activeClip?.id]);

  useEffect(() => {
    if (!isPlaying) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const next = playhead + dt;
      if (next >= duration) {
        setIsPlaying(false);
        setPlayhead(duration);
        return;
      }
      setPlayhead(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  return (
    <div className="preview">
      <div className="preview-canvas">
        {activeClip ? (
          <video ref={videoRef} className="preview-video" muted={false} playsInline />
        ) : (
          <div className="preview-empty">No clip at playhead</div>
        )}
      </div>
      <div className="preview-controls">
        <button className="btn-icon" onClick={() => setIsPlaying(!isPlaying)}>
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span>
          {playhead.toFixed(2)}s / {duration.toFixed(2)}s
        </span>
      </div>
    </div>
  );
}

export { clipEnd };
