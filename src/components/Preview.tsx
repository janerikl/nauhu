import { useEffect, useRef } from "react";
import { useEditorStore } from "../store/editorStore";
import { type Clip, clipEnd, findActiveClip } from "../lib/timeline-math";
import { Play, Pause } from "lucide-react";

const SEEK_EPSILON = 0.05;

export function Preview() {
  const clips = useEditorStore((s) => s.clips);
  const sources = useEditorStore((s) => s.sources);
  const tracks = useEditorStore((s) => s.tracks);
  const playhead = useEditorStore((s) => s.playhead);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setIsPlaying = useEditorStore((s) => s.setIsPlaying);
  const duration = useEditorStore((s) => s.duration());

  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const activeClipIdRef = useRef<string | null>(null);
  const activeClipRef = useRef<Clip | undefined>(undefined);

  const activeClip = findActiveClip(clips, tracks, "video", playhead);
  const activeSource = activeClip ? sources.find((s) => s.id === activeClip.sourceId) : undefined;
  activeClipRef.current = activeClip;

  // Switch the underlying <video> element's source when the active clip changes.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip || !activeSource) return;
    if (activeClipIdRef.current === activeClip.id) return;
    activeClipIdRef.current = activeClip.id;
    video.src = activeSource.url;
    video.currentTime = activeClip.sourceIn + (playhead - activeClip.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClip?.id, activeSource?.url]);

  // Seek the video whenever the playhead is moved externally (ruler click, scrub).
  // Skipped while playing since playback itself is what's advancing the playhead.
  useEffect(() => {
    if (isPlaying) return;
    const video = videoRef.current;
    if (!video || !activeClip) return;
    const clipLocalTime = activeClip.sourceIn + (playhead - activeClip.start);
    if (Math.abs(video.currentTime - clipLocalTime) > SEEK_EPSILON) {
      video.currentTime = clipLocalTime;
    }
  }, [playhead, activeClip, isPlaying]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) video.play().catch(() => {});
    else video.pause();
  }, [isPlaying, activeClip?.id]);

  // While playing, drive the timeline playhead from the video element's own
  // currentTime so displayed time always matches actual playback, detect
  // when a clip ends to advance to the next one, and fall back to a
  // wall-clock advance through gaps (no clip under the playhead) since
  // there's no video element/currentTime to follow there.
  useEffect(() => {
    if (!isPlaying) return;
    let lastTs = performance.now();

    const tick = (now: number) => {
      const dt = (now - lastTs) / 1000;
      lastTs = now;

      const video = videoRef.current;
      const clip = activeClipRef.current;

      if (clip && video) {
        if (video.currentTime >= clip.sourceOut - 0.02) {
          const next = clipEnd(clip);
          if (next >= duration) {
            setIsPlaying(false);
            setPlayhead(duration);
            return;
          }
          setPlayhead(next);
        } else {
          setPlayhead(clip.start + (video.currentTime - clip.sourceIn));
        }
      } else {
        const next = useEditorStore.getState().playhead + dt;
        if (next >= duration) {
          setIsPlaying(false);
          setPlayhead(duration);
          return;
        }
        setPlayhead(next);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, duration, setPlayhead, setIsPlaying]);

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
