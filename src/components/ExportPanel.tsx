import { useState } from "react";
import { useEditorStore } from "../store/editorStore";
import { exportTimeline } from "../lib/ffmpeg-export";
import { Download, Loader2 } from "lucide-react";

export function ExportPanel() {
  const clips = useEditorStore((s) => s.clips);
  const sources = useEditorStore((s) => s.sources);
  const tracks = useEditorStore((s) => s.tracks);
  const [status, setStatus] = useState<"idle" | "loading" | "exporting" | "done" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  // Export currently supports a single video track (no cross-track overlay
  // compositing yet); pick the first video track, in track order, that
  // actually has clips rather than hardcoding the original default track.
  const exportTrackId = tracks.find(
    (t) => t.kind === "video" && clips.some((c) => c.trackId === t.id)
  )?.id;
  const hasClips = exportTrackId !== undefined;

  const handleExport = async () => {
    if (!exportTrackId) return;
    setStatus("loading");
    setError("");
    try {
      setStatus("exporting");
      const blob = await exportTimeline(clips, sources, exportTrackId, setProgress);
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

  return (
    <div className="export-panel">
      <button className="btn-primary" disabled={!hasClips || status === "exporting" || status === "loading"} onClick={handleExport}>
        {status === "exporting" || status === "loading" ? (
          <>
            <Loader2 size={14} className="spin" /> {status === "loading" ? "Loading engine..." : `Exporting ${(progress * 100).toFixed(0)}%`}
          </>
        ) : (
          <>
            <Download size={14} /> Export MP4
          </>
        )}
      </button>
      {status === "error" && <div className="export-error">{error}</div>}
      {status === "done" && <div className="export-done">Export complete</div>}
    </div>
  );
}
