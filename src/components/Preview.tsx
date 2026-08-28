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
  const loadedSourceUrlRef = useRef<string | null>(null);
  const activeClipRef = useRef<Clip | undefined>(undefined);

  const activeClip = findActiveClip(clips, tracks, "video", playhead);
  const activeSource = activeClip ? sources.find((s) => s.id === activeClip.sourceId) : undefined;
  activeClipRef.current = activeClip;

  // Switch the underlying <video> element's source when the active clip changes.
  // Two clips split from the same original clip share a source/url - only
  // reassign .src when the underlying media actually changes. Some browsers
  // treat re-assigning .src to its current value as a fresh load, which
  // resets/stalls playback right at the clip boundary instead of continuing
  // seamlessly through the same file.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip || !activeSource) return;
    if (activeClipIdRef.current === activeClip.id) return;
    activeClipIdRef.current = activeClip.id;

    const targetTime = activeClip.sourceIn + (playhead - activeClip.start);

    const seekAndResumeIfPlaying = () => {
      video.currentTime = targetTime;
      if (useEditorStore.getState().isPlaying) video.play().catch(() => {});
    };

    if (loadedSourceUrlRef.current !== activeSource.url) {
      // Setting currentTime immediately after assigning a new .src is a race:
      // the browser can reset currentTime back to 0 once it actually starts
      // loading the new source, silently clobbering the seek. Wait for
      // loadedmetadata (when currentTime becomes settable/durable) instead.
      loadedSourceUrlRef.current = activeSource.url;
      video.src = activeSource.url;
      video.addEventListener("loadedmetadata", seekAndResumeIfPlaying, { once: true });
      return () => video.removeEventListener("loadedmetadata", seekAndResumeIfPlaying);
    }

    seekAndResumeIfPlaying();
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

  // Advances the playhead past `clip` to whatever comes next (another clip,
  // a gap, or the end of the timeline). Shared by the polling threshold
  // check below and the video's native 'ended' backstop.
  const advancePastClip = (clip: Clip) => {
    const next = clipEnd(clip);
    if (next >= duration) {
      setIsPlaying(false);
      setPlayhead(duration);
      return;
    }
    setPlayhead(next);
  };

  // A clip can stop advancing (native 'ended', a stall, decoder precision)
  // slightly before currentTime reaches the sourceOut-based polling
  // threshold in the tick loop below, in which case that loop's condition
  // never becomes true and playback looks permanently stuck at the
  // boundary. The video's own 'ended' event is a reliable backstop for
  // this: whenever the browser itself decides this clip is done, advance
  // immediately regardless of what currentTime polling has observed.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnded = () => {
      const clip = activeClipRef.current;
      if (clip) advancePastClip(clip);
    };
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClip?.id, duration]);

  // While playing, drive the timeline playhead from the video element's own
  // currentTime so displayed time always matches actual playback, detect
  // when a clip ends to advance to the next one, and fall back to a
  // wall-clock advance through gaps (no clip under the playhead) since
  // there's no video element/currentTime to follow there.
  useEffect(() => {
    if (!isPlaying) return;
    let lastTs = performance.now();
    let stalledSince: number | null = null;
    let lastObservedTime = -1;
    let lastPlayRetryTs = 0;

    const tick = (now: number) => {
      const dt = (now - lastTs) / 1000;
      lastTs = now;

      const video = videoRef.current;
      const clip = activeClipRef.current;

      // Self-healing watchdog: we believe playback is in progress (isPlaying
      // is true) but the element itself is paused - can happen if a play()
      // call from within an automatic clip transition silently didn't take.
      // Re-issue it, throttled, exactly like manually toggling play/pause
      // (which is known to reliably resume it) does.
      if (video && clip && video.paused && now - lastPlayRetryTs > 200) {
        lastPlayRetryTs = now;
        video.play().catch(() => {});
      }

      if (clip && video) {
        if (video.currentTime >= clip.sourceOut - 0.02) {
          advancePastClip(clip);
          stalledSince = null;
          lastObservedTime = -1;
        } else {
          setPlayhead(clip.start + (video.currentTime - clip.sourceIn));

          // Backstop for when the video stops making progress (paused,
          // buffering-stalled, or the browser's own end-of-media handling)
          // before currentTime ever reaches the threshold above: if it
          // hasn't moved for ~600ms while we still expect it to be playing,
          // treat this clip as done rather than staying stuck indefinitely.
          if (video.currentTime === lastObservedTime) {
            if (stalledSince === null) stalledSince = now;
            else if (now - stalledSince > 600) {
              advancePastClip(clip);
              stalledSince = null;
              lastObservedTime = -1;
              rafRef.current = requestAnimationFrame(tick);
              return;
            }
          } else {
            lastObservedTime = video.currentTime;
            stalledSince = null;
          }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
