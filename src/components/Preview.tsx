import { useEffect, useRef, type CSSProperties } from "react";
import { useEditorStore } from "../store/editorStore";
import {
  type Clip,
  type TransitionType,
  clipEnd,
  findActivePair,
  findCrossTrackActivePair,
  transitionKey,
} from "../lib/timeline-math";
import { Play, Pause, SkipBack } from "lucide-react";

const SEEK_EPSILON = 0.05;

/** Draws `video`'s current frame into `ctx` fit-contain within the canvas, at `alpha` opacity and an optional horizontal pixel offset / uniform scale (used by slide/zoom). */
function drawContain(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  video: HTMLVideoElement,
  alpha: number,
  xOffset = 0,
  scale = 1
) {
  if (!video.videoWidth || alpha <= 0) return;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const fit = Math.min(canvasW / vw, canvasH / vh) * scale;
  const dw = vw * fit;
  const dh = vh * fit;
  const dx = (canvasW - dw) / 2 + xOffset;
  const dy = (canvasH - dh) / 2;
  ctx.globalAlpha = alpha;
  ctx.drawImage(video, dx, dy, dw, dh);
  ctx.globalAlpha = 1;
}

/** Composites the outgoing (`videoA`) and incoming (`videoB`) clip frames for one transition frame. `p` is transition progress from 0 (fully A) to 1 (fully B). */
function compositeTransition(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  videoA: HTMLVideoElement,
  videoB: HTMLVideoElement,
  type: TransitionType,
  p: number
) {
  ctx.clearRect(0, 0, w, h);
  switch (type) {
    case "crossfade":
      drawContain(ctx, w, h, videoA, 1 - p);
      drawContain(ctx, w, h, videoB, p);
      break;
    case "fadeToBlack":
      if (p < 0.5) {
        drawContain(ctx, w, h, videoA, 1);
        ctx.fillStyle = "black";
        ctx.globalAlpha = p * 2;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      } else {
        drawContain(ctx, w, h, videoB, 1);
        ctx.fillStyle = "black";
        ctx.globalAlpha = (1 - p) * 2;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      }
      break;
    case "wipe":
      drawContain(ctx, w, h, videoA, 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w * p, h);
      ctx.clip();
      drawContain(ctx, w, h, videoB, 1);
      ctx.restore();
      break;
    case "slide":
      drawContain(ctx, w, h, videoA, 1, -w * p);
      drawContain(ctx, w, h, videoB, 1, w * (1 - p));
      break;
    case "zoom":
      drawContain(ctx, w, h, videoA, 1 - p, 0, 1 + p * 0.3);
      drawContain(ctx, w, h, videoB, p, 0, 1.3 - p * 0.3);
      break;
  }
}

export function Preview() {
  const clips = useEditorStore((s) => s.clips);
  const sources = useEditorStore((s) => s.sources);
  const tracks = useEditorStore((s) => s.tracks);
  const playhead = useEditorStore((s) => s.playhead);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setIsPlaying = useEditorStore((s) => s.setIsPlaying);
  const duration = useEditorStore((s) => s.duration());
  const transitionTypes = useEditorStore((s) => s.transitionTypes);

  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const activeClipIdRef = useRef<string | null>(null);
  const loadedSourceUrlRef = useRef<string | null>(null);
  const activeClipRef = useRef<Clip | undefined>(undefined);

  // Secondary video element + canvas, used only while a transition overlap is active.
  const video2Ref = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafCanvasRef = useRef<number>(0);
  const secondaryClipIdRef = useRef<string | null>(null);
  const loadedSecondaryUrlRef = useRef<string | null>(null);

  const crossTrackPair = findCrossTrackActivePair(clips, tracks, transitionTypes, playhead);
  const { primary: activeClip, secondary: secondaryClip } =
    crossTrackPair ?? findActivePair(clips, tracks, "video", playhead);
  const activeSource = activeClip ? sources.find((s) => s.id === activeClip.sourceId) : undefined;
  const secondarySource = secondaryClip
    ? sources.find((s) => s.id === secondaryClip.sourceId)
    : undefined;
  const isImageActive = activeSource?.kind === "image";
  const isImageSecondary = secondarySource?.kind === "image";
  activeClipRef.current = activeClip;

  const transitionType: TransitionType =
    activeClip && secondaryClip
      ? (transitionTypes[transitionKey(activeClip.id, secondaryClip.id)] ?? "crossfade")
      : "crossfade";

  // Switch the underlying <video> element's source when the active clip changes.
  // Two clips split from the same original clip share a source/url - only
  // reassign .src when the underlying media actually changes. Some browsers
  // treat re-assigning .src to its current value as a fresh load, which
  // resets/stalls playback right at the clip boundary instead of continuing
  // seamlessly through the same file.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip || !activeSource || isImageActive) {
      activeClipIdRef.current = null;
      return;
    }
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

  // Same source/seek handling as the primary video, for the incoming clip
  // during a transition overlap.
  useEffect(() => {
    const video = video2Ref.current;
    if (!video || !secondaryClip || !secondarySource || isImageSecondary) {
      secondaryClipIdRef.current = null;
      return;
    }
    if (secondaryClipIdRef.current === secondaryClip.id) return;
    secondaryClipIdRef.current = secondaryClip.id;

    const targetTime = secondaryClip.sourceIn + (playhead - secondaryClip.start);

    const seekAndResumeIfPlaying = () => {
      video.currentTime = targetTime;
      if (useEditorStore.getState().isPlaying) video.play().catch(() => {});
    };

    if (loadedSecondaryUrlRef.current !== secondarySource.url) {
      loadedSecondaryUrlRef.current = secondarySource.url;
      video.src = secondarySource.url;
      video.addEventListener("loadedmetadata", seekAndResumeIfPlaying, { once: true });
      return () => video.removeEventListener("loadedmetadata", seekAndResumeIfPlaying);
    }

    seekAndResumeIfPlaying();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondaryClip?.id, secondarySource?.url]);

  // Seek the video whenever the playhead is moved externally (ruler click,
  // scrub, Home, a ripple edit shifting the playhead). During normal
  // self-driven playback the tick loop derives `playhead` from
  // `video.currentTime`, so this diff is always ~0 and the effect is a
  // no-op then - it only actually seeks on a genuine external jump, which
  // can happen while `isPlaying` is true (e.g. Home sets playhead and
  // isPlaying together), so this must not be skipped based on isPlaying.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip || isImageActive) return;
    const clipLocalTime = activeClip.sourceIn + (playhead - activeClip.start);
    if (Math.abs(video.currentTime - clipLocalTime) > SEEK_EPSILON) {
      video.currentTime = clipLocalTime;
    }
  }, [playhead, activeClip, isImageActive]);

  useEffect(() => {
    const video = video2Ref.current;
    if (!video || !secondaryClip || isImageSecondary) return;
    const clipLocalTime = secondaryClip.sourceIn + (playhead - secondaryClip.start);
    if (Math.abs(video.currentTime - clipLocalTime) > SEEK_EPSILON) {
      video.currentTime = clipLocalTime;
    }
  }, [playhead, secondaryClip, isImageSecondary]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || isImageActive) return;
    if (isPlaying) video.play().catch(() => {});
    else video.pause();
  }, [isPlaying, activeClip?.id, isImageActive]);

  useEffect(() => {
    const video = video2Ref.current;
    if (!video || !secondaryClip || isImageSecondary) return;
    if (isPlaying) video.play().catch(() => {});
    else video.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, secondaryClip?.id, isImageSecondary]);

  // Crossfade audio between the two elements across the transition, so the
  // incoming clip's sound fades in as the outgoing clip's fades out.
  useEffect(() => {
    const videoA = videoRef.current;
    const videoB = video2Ref.current;
    if (!videoA) return;
    if (!secondaryClip || !activeClip) {
      videoA.volume = 1;
      return;
    }
    const overlapDuration = clipEnd(activeClip) - secondaryClip.start;
    const p =
      overlapDuration > 0
        ? Math.min(1, Math.max(0, (playhead - secondaryClip.start) / overlapDuration))
        : 0;
    videoA.volume = 1 - p;
    if (videoB) videoB.volume = p;
  }, [playhead, activeClip, secondaryClip]);

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
      const clipSource = clip
        ? useEditorStore.getState().sources.find((s) => s.id === clip.sourceId)
        : undefined;
      const clipIsImage = clipSource?.kind === "image";

      // Self-healing watchdog: we believe playback is in progress (isPlaying
      // is true) but the element itself is paused - can happen if a play()
      // call from within an automatic clip transition silently didn't take.
      // Re-issue it, throttled, exactly like manually toggling play/pause
      // (which is known to reliably resume it) does. Doesn't apply to an
      // image clip - there's no <video> playback to babysit for those.
      if (video && clip && !clipIsImage && video.paused && now - lastPlayRetryTs > 200) {
        lastPlayRetryTs = now;
        video.play().catch(() => {});
      }

      if (clip && clipIsImage) {
        // Static image clips have no media element driving progress -
        // advance the playhead by wall-clock time until the clip's out
        // point, same principle as the gap fallback below.
        const next = Math.min(useEditorStore.getState().playhead + dt, clipEnd(clip));
        if (next >= clipEnd(clip) - 0.001) {
          advancePastClip(clip);
        } else {
          setPlayhead(next);
        }
      } else if (clip && video) {
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
        const state = useEditorStore.getState();
        const videoTrackIds = new Set(
          state.tracks.filter((t) => t.kind === "video").map((t) => t.id)
        );
        const nextClipStart = state.clips
          .filter((c) => videoTrackIds.has(c.trackId) && c.start > state.playhead)
          .reduce((min, c) => Math.min(min, c.start), duration);

        const next = Math.min(state.playhead + dt, nextClipStart, duration);
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

  // Canvas compositing loop: only runs while a transition overlap is active
  // (secondaryClip present). Draws both videos' current frames blended per
  // the chosen transition effect. Outside a transition the plain <video> is
  // shown directly and this canvas stays hidden, so normal playback is
  // exactly the single-<video> behavior above, unmodified.
  useEffect(() => {
    const canvas = canvasRef.current;
    const videoA = videoRef.current;
    const videoB = video2Ref.current;
    if (!canvas || !videoA || !videoB || !activeClip || !secondaryClip) return;

    const overlapDuration = clipEnd(activeClip) - secondaryClip.start;

    const draw = () => {
      const w = videoA.videoWidth || 1280;
      const h = videoA.videoHeight || 720;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const p =
        overlapDuration > 0
          ? Math.min(1, Math.max(0, (useEditorStore.getState().playhead - secondaryClip.start) / overlapDuration))
          : 0;
      compositeTransition(ctx, w, h, videoA, videoB, transitionType, p);
      rafCanvasRef.current = requestAnimationFrame(draw);
    };

    rafCanvasRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafCanvasRef.current);
  }, [activeClip, secondaryClip, transitionType]);

  const inTransition = Boolean(activeClip && secondaryClip);
  // Videos not currently shown stay decoding off-screen (not display:none,
  // which some browsers pause decoding for) so canvas compositing always has
  // a fresh frame to draw the instant a transition starts.
  const offscreenStyle: CSSProperties = {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    pointerEvents: "none",
  };

  return (
    <div className="preview">
      <div className="preview-canvas">
        {activeClip ? (
          <>
            {isImageActive && activeSource && !inTransition && (
              <img src={activeSource.url} className="preview-video" alt="" />
            )}
            <video
              ref={videoRef}
              className="preview-video"
              style={isImageActive || inTransition ? offscreenStyle : undefined}
              muted={false}
              playsInline
            />
            <video ref={video2Ref} className="preview-video" style={offscreenStyle} muted={false} playsInline />
            <canvas
              ref={canvasRef}
              className="preview-video"
              style={{ display: inTransition ? "block" : "none" }}
            />
          </>
        ) : (
          <div className="preview-empty">No clip at playhead</div>
        )}
      </div>
      <div className="preview-controls">
        <button
          className="btn-icon"
          title="Play from beginning (Home)"
          onClick={() => {
            setPlayhead(0);
            setIsPlaying(true);
          }}
        >
          <SkipBack size={16} />
        </button>
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
