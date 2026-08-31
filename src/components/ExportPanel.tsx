import { useState, useRef, useCallback, useEffect } from "react";
import { useEditorStore } from "../store/editorStore";
import { exportTimeline, EXPORT_RESOLUTIONS, type ExportResolutionKey } from "../lib/ffmpeg-export";
import { Download, Loader2 } from "lucide-react";

export function ExportPanel() {
  const clips = useEditorStore((s) => s.clips);
  const sources = useEditorStore((s) => s.sources);
  const tracks = useEditorStore((s) => s.tracks);
  const transitions = useEditorStore((s) => s.transitions);
  const [status, setStatus] = useState<"idle" | "loading" | "exporting" | "done" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [resolution, setResolution] = useState<ExportResolutionKey>("1080p");

  // ffmpeg's progress event can fire many times per second (it runs in its own
  // Web Worker, so this doesn't block encoding, but forwarding every tick
  // straight into React state floods the main thread with re-renders and
  // makes the tab feel like it's hanging). Coalesce updates to one per frame.
  const latestProgress = useRef(0);
  const rafId = useRef<number | null>(null);
  const handleProgress = useCallback((ratio: number) => {
    latestProgress.current = ratio;
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      setProgress(latestProgress.current);
    });
  }, []);
  useEffect(() => {
    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    };
  }, []);

  // The primary track defines the export's base timeline/duration; any other
  // video tracks are composited on top of it (see exportTimeline). Pick the
  // first video track, in track order, that actually has clips rather than
  // hardcoding the original default track.
  const exportTrackId = tracks.find(
    (t) => t.kind === "video" && clips.some((c) => c.trackId === t.id)
  )?.id;
  const hasClips = exportTrackId !== undefined;

  const handleExport = async () => {
    if (!exportTrackId) return;
    setStatus("loading");
    setError("");
    latestProgress.current = 0;
    setProgress(0);
    try {
      setStatus("exporting");
      const blob = await exportTimeline(
        clips,
        sources,
        exportTrackId,
        handleProgress,
        tracks,
        transitions,
        EXPORT_RESOLUTIONS[resolution]
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "export.mp4";
      a.click();
      URL.revokeObjectURL(url);
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
      setStatus("error");
    }
  };

  const isBusy = status === "exporting" || status === "loading";

  return (
    <div className="export-panel">
      <div className="export-panel-row">
        <select
          className="export-resolution"
          value={resolution}
          disabled={isBusy}
          onChange={(e) => setResolution(e.target.value as ExportResolutionKey)}
          title="Export resolution"
        >
          <option value="1080p">1080p (Full HD)</option>
          <option value="4k">4K (Ultra HD)</option>
        </select>
        <button className="btn-primary" disabled={!hasClips || isBusy} onClick={handleExport}>
          {status === "exporting" || status === "loading" ? (
            <>
              <Loader2 size={14} className="spin" /> {status === "loading" ? "Loading engine..." : `Exporting ${Math.min(100, Math.max(0, progress * 100)).toFixed(0)}%`}
            </>
          ) : (
            <>
              <Download size={14} /> Export MP4
            </>
          )}
        </button>
      </div>
      {resolution === "4k" && !isBusy && (
        <div className="export-hint">4K is much slower and uses more memory - may fail on long timelines.</div>
      )}
      {status === "error" && <div className="export-error">{error}</div>}
      {status === "done" && <div className="export-done">Export complete</div>}
    </div>
  );
}
