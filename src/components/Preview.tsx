import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useEditorStore } from "../store/editorStore";
import {
  type Clip,
  type TransitionType,
  clipEnd,
  findActivePair,
  findCrossTrackActivePair,
  getTransitionType,
} from "../lib/timeline-math";
import { EXPORT_HEIGHT } from "../lib/ffmpeg-export";
import { Play, Pause, SkipBack } from "lucide-react";

/** Fraction (0-1) visible for a text clip at `playhead`, ramping over its fadeIn/fadeOut windows. */
function textClipOpacity(clip: Clip, playhead: number): number {
  const style = clip.text;
  if (!style) return 0;
  const localT = playhead - clip.start;
  const clipDur = clipEnd(clip) - clip.start;
  let opacity = 1;
  if (style.fadeIn > 0) opacity = Math.min(opacity, localT / style.fadeIn);
  if (style.fadeOut > 0) opacity = Math.min(opacity, (clipDur - localT) / style.fadeOut);
  return Math.max(0, Math.min(1, opacity));
}

const SEEK_EPSILON = 0.05;
// The audio element isn't what drives `playhead` (the primary video is), so
// its own clock naturally drifts a bit from the video-derived playhead even
// during normal, correctly-synced playback. A tight epsilon here (matching
// the video's, which IS the playhead's source of truth) causes frequent
// small corrective hard-seeks on the audio element, and each one is an
// audible glitch - together they sound like distortion. A looser tolerance
// only fires this correction for genuine external jumps (scrub, Home),
// which are much larger than routine clock drift.
const AUDIO_SEEK_EPSILON = 0.25;
/** video.readyState value meaning "has a decoded frame for the current position", per HTMLMediaElement. */
const HAVE_CURRENT_DATA = 2;

/** A transition endpoint's drawable frame source: either a decoding `<video>` or a loaded `<img>`. */
type FrameSource = HTMLVideoElement | HTMLImageElement;

/** Natural pixel dimensions of a frame source, regardless of whether it's a video or an image. */
function frameSize(source: FrameSource): { w: number; h: number } {
  if (source instanceof HTMLVideoElement) return { w: source.videoWidth, h: source.videoHeight };
  return { w: source.naturalWidth, h: source.naturalHeight };
}

/** Draws `source`'s current frame into `ctx` fit-contain within the canvas, at `alpha` opacity and an optional horizontal pixel offset / uniform scale (used by slide/zoom). */
function drawContain(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  source: FrameSource,
  alpha: number,
  xOffset = 0,
  scale = 1
) {
  const { w: vw, h: vh } = frameSize(source);
  if (!vw || !vh || alpha <= 0) return;
  const fit = Math.min(canvasW / vw, canvasH / vh) * scale;
  const dw = vw * fit;
  const dh = vh * fit;
  const dx = (canvasW - dw) / 2 + xOffset;
  const dy = (canvasH - dh) / 2;
  ctx.globalAlpha = alpha;
  ctx.drawImage(source, dx, dy, dw, dh);
  ctx.globalAlpha = 1;
}

/** Composites the outgoing (`videoA`) and incoming (`videoB`) clip frames for one transition frame. `p` is transition progress from 0 (fully A) to 1 (fully B). */
function compositeTransition(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  videoA: FrameSource,
  videoB: FrameSource,
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
  const transitions = useEditorStore((s) => s.transitions);

  const previewCanvasRef = useRef<HTMLDivElement>(null);
  const [previewHeightPx, setPreviewHeightPx] = useState(0);
  useEffect(() => {
    const el = previewCanvasRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => setPreviewHeightPx(entries[0].contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const textScale = previewHeightPx > 0 ? previewHeightPx / EXPORT_HEIGHT : 0;

  const textTrackIds = new Set(tracks.filter((t) => t.kind === "text").map((t) => t.id));
  const activeTextClips = clips.filter(
    (c) => c.text && textTrackIds.has(c.trackId) && playhead >= c.start && playhead < clipEnd(c)
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const activeClipIdRef = useRef<string | null>(null);
  const loadedSourceUrlRef = useRef<string | null>(null);
  const activeClipRef = useRef<Clip | undefined>(undefined);

  // Secondary video element + canvas, used only while a transition overlap is active.
  const video2Ref = useRef<HTMLVideoElement>(null);
  // Hidden <img> elements mirroring videoRef/video2Ref for image-kind clips,
  // kept mounted unconditionally (not gated by !inTransition) so the canvas
  // compositor always has a decoded image frame to draw from the instant a
  // transition starts, the same way the off-screen <video>s stay decoding.
  const imgRef = useRef<HTMLImageElement>(null);
  const img2Ref = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafCanvasRef = useRef<number>(0);
  const secondaryClipIdRef = useRef<string | null>(null);
  const loadedSecondaryUrlRef = useRef<string | null>(null);

  const crossTrackPair = findCrossTrackActivePair(clips, tracks, transitions, playhead);
  const { primary: activeClip, secondary: secondaryClip } =
    crossTrackPair ?? findActivePair(clips, tracks, "video", playhead);
  const activeSource = activeClip ? sources.find((s) => s.id === activeClip.sourceId) : undefined;

  // Audio track playback: independent of whatever's active on the video
  // track(s) - the timeline's own <video> elements only ever play back
  // clips that live on a "video" track, so a clip on an "audio" track needs
  // its own element driven the same way (source-switch, seek, play/pause).
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeAudioClipIdRef = useRef<string | null>(null);
  const loadedAudioUrlRef = useRef<string | null>(null);
  const { primary: activeAudioClip } = findActivePair(clips, tracks, "audio", playhead);
  const activeAudioSource = activeAudioClip
    ? sources.find((s) => s.id === activeAudioClip.sourceId)
    : undefined;
  const secondarySource = secondaryClip
    ? sources.find((s) => s.id === secondaryClip.sourceId)
    : undefined;
  const isImageActive = activeSource?.kind === "image";
  const isImageSecondary = secondarySource?.kind === "image";
  activeClipRef.current = activeClip;

  const transitionType: TransitionType =
    activeClip && secondaryClip ? getTransitionType(transitions, activeClip.id, secondaryClip.id) : "crossfade";

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

  // Set `muted` imperatively rather than relying solely on the JSX prop:
  // React doesn't reliably re-apply the `muted` IDL property to an existing
  // <video> element on every update (it's a known quirk - the attribute only
  // really takes on creation), so a clip that should be silent (its audio
  // split onto the audio track) could otherwise keep playing its own
  // embedded audio alongside the separate <audio> element, doubling up into
  // a phased/distorted sound.
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = Boolean(activeClip?.mutedVideo);
  }, [activeClip?.id, activeClip?.mutedVideo]);

  useEffect(() => {
    const video = video2Ref.current;
    if (video) video.muted = Boolean(secondaryClip?.mutedVideo);
  }, [secondaryClip?.id, secondaryClip?.mutedVideo]);

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

  // Switch the <audio> element's source when the active audio-track clip
  // changes, same rationale as the primary video's source-switch effect
  // above (avoid a spurious reload when the underlying source hasn't
  // actually changed).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeAudioClip || !activeAudioSource) {
      activeAudioClipIdRef.current = null;
      return;
    }
    if (activeAudioClipIdRef.current === activeAudioClip.id) return;
    activeAudioClipIdRef.current = activeAudioClip.id;

    const targetTime = activeAudioClip.sourceIn + (playhead - activeAudioClip.start);

    const seekAndResumeIfPlaying = () => {
      audio.currentTime = targetTime;
      if (useEditorStore.getState().isPlaying) audio.play().catch(() => {});
    };

    if (loadedAudioUrlRef.current !== activeAudioSource.url) {
      loadedAudioUrlRef.current = activeAudioSource.url;
      audio.src = activeAudioSource.url;
      audio.addEventListener("loadedmetadata", seekAndResumeIfPlaying, { once: true });
      return () => audio.removeEventListener("loadedmetadata", seekAndResumeIfPlaying);
    }

    seekAndResumeIfPlaying();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAudioClip?.id, activeAudioSource?.url]);

  // Seek the audio element on external playhead jumps, mirroring the video's
  // equivalent effect.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeAudioClip) return;
    const clipLocalTime = activeAudioClip.sourceIn + (playhead - activeAudioClip.start);
    if (Math.abs(audio.currentTime - clipLocalTime) > AUDIO_SEEK_EPSILON) {
      audio.currentTime = clipLocalTime;
    }
  }, [playhead, activeAudioClip]);

  // Pause the audio element once there's no clip under the playhead on any
  // audio track, and start/stop it in step with the rest of the timeline.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!activeAudioClip) {
      audio.pause();
      return;
    }
    if (isPlaying) audio.play().catch(() => {});
    else audio.pause();
  }, [isPlaying, activeAudioClip?.id]);

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
      if (!clip) return;
      const clipSource = useEditorStore.getState().sources.find((s) => s.id === clip.sourceId);
      // The active clip can already be a later image clip by the time this
      // native event fires (the tick loop's own threshold check may have
      // advanced past the video first) - only this <video> element's own
      // clip should ever be advanced from its 'ended' event.
      if (clipSource?.kind === "image") return;
      advancePastClip(clip);
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
      } else if (clip && video && !clipIsImage) {
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
          // A freshly-assigned .src reports HAVE_NOTHING/HAVE_METADATA (and
          // currentTime === 0) for a little while before the browser has
          // actually decoded a frame - that's normal startup latency, not a
          // stall, so don't start (or count against) the stall clock until
          // the video has at least a current frame available. Without this,
          // a clip whose src just switched can get force-skipped to its end
          // before it ever gets a chance to start playing.
          if (video.readyState < HAVE_CURRENT_DATA) {
            stalledSince = null;
          } else if (video.currentTime === lastObservedTime) {
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
    const sourceA: FrameSource | null = isImageActive ? imgRef.current : videoRef.current;
    const sourceB: FrameSource | null = isImageSecondary ? img2Ref.current : video2Ref.current;
    if (!canvas || !sourceA || !sourceB || !activeClip || !secondaryClip) return;

    const overlapDuration = clipEnd(activeClip) - secondaryClip.start;

    const draw = () => {
      const { w: aw, h: ah } = frameSize(sourceA);
      const { w: bw, h: bh } = frameSize(sourceB);
      const w = aw || bw || 1280;
      const h = ah || bh || 720;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const p =
        overlapDuration > 0
          ? Math.min(1, Math.max(0, (useEditorStore.getState().playhead - secondaryClip.start) / overlapDuration))
          : 0;
      compositeTransition(ctx, w, h, sourceA, sourceB, transitionType, p);
      rafCanvasRef.current = requestAnimationFrame(draw);
    };

    rafCanvasRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafCanvasRef.current);
  }, [activeClip, secondaryClip, transitionType, isImageActive, isImageSecondary]);

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
      <div className="preview-canvas" ref={previewCanvasRef}>
        {/*
          The <video>/<video2>/<canvas> elements stay mounted unconditionally
          (visibility toggled via style, not the JSX tree) rather than being
          gated behind `activeClip ? ... : ...`. Unmounting them whenever
          `activeClip` goes briefly undefined - which can genuinely happen for
          a render or two while dragging a clip past the playhead - would
          destroy the DOM node `videoRef`/`video2Ref` point at. A later
          remount creates a fresh, src-less element, but the source-switch
          effects' `activeClipIdRef`/`loadedSourceUrlRef` guards can still
          think the (new, blank) element already has the right source loaded
          and skip re-assigning `.src` - leaving the preview permanently
          black even after `activeClip` settles back down.
        */}
        {isImageActive && activeSource && !inTransition && (
          <img src={activeSource.url} className="preview-video" alt="" />
        )}
        {/*
          Kept mounted whenever the active/secondary clip is an image, even
          during a transition (unlike the visible <img> above, which hides
          then) - the canvas compositor reads its decoded frame directly via
          imgRef/img2Ref, the same way it reads videoRef/video2Ref for video
          clips.
        */}
        {isImageActive && activeSource && (
          <img ref={imgRef} src={activeSource.url} className="preview-video" style={offscreenStyle} alt="" />
        )}
        {isImageSecondary && secondarySource && (
          <img ref={img2Ref} src={secondarySource.url} className="preview-video" style={offscreenStyle} alt="" />
        )}
        <video
          ref={videoRef}
          className="preview-video"
          style={!activeClip || isImageActive || inTransition ? offscreenStyle : undefined}
          muted={Boolean(activeClip?.mutedVideo)}
          playsInline
        />
        <video
          ref={video2Ref}
          className="preview-video"
          style={offscreenStyle}
          muted={Boolean(secondaryClip?.mutedVideo)}
          playsInline
        />
        <canvas
          ref={canvasRef}
          className="preview-video"
          style={{ display: inTransition ? "block" : "none" }}
        />
        {!activeClip && <div className="preview-empty">No clip at playhead</div>}
        <audio ref={audioRef} style={{ display: "none" }} />
        {textScale > 0 &&
          activeTextClips.map((clip) => {
            const style = clip.text!;
            const opacity = textClipOpacity(clip, playhead);
            const justify =
              style.align === "left" ? "flex-start" : style.align === "right" ? "flex-end" : "center";
            const alignSelf =
              style.verticalAlign === "top" ? "flex-start" : style.verticalAlign === "bottom" ? "flex-end" : "center";
            return (
              <div
                key={clip.id}
                className="preview-text-overlay"
                style={{ justifyContent: justify, alignItems: alignSelf }}
              >
                <span
                  style={{
                    color: style.color,
                    fontFamily: style.fontFamily,
                    fontSize: style.fontSize * textScale,
                    textAlign: style.align,
                    opacity,
                  }}
                >
                  {style.content}
                </span>
              </div>
            );
          })}
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
