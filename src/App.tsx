import { useEffect } from "react";
import { MediaBin } from "./components/MediaBin";
import { Timeline } from "./components/Timeline";
import { Preview } from "./components/Preview";
import { ExportPanel } from "./components/ExportPanel";
import { useEditorStore } from "./store/editorStore";
import { useProjectPersistence } from "./hooks/useProjectPersistence";
import "./App.css";

function App() {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const splitClipAtPlayhead = useEditorStore((s) => s.splitClipAtPlayhead);
  const removeClip = useEditorStore((s) => s.removeClip);
  const saveStatus = useEditorStore((s) => s.saveStatus);

  useProjectPersistence();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        useEditorStore.getState().setIsPlaying(!useEditorStore.getState().isPlaying);
      } else if (e.key === "s" && selectedClipId) {
        splitClipAtPlayhead(selectedClipId);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedClipId) removeClip(selectedClipId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedClipId, splitClipAtPlayhead, removeClip]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Web Video Editor</h1>
        <div className="app-header-right">
          {saveStatus !== "idle" && (
            <span className="save-status">{saveStatus === "saving" ? "Saving…" : "Saved"}</span>
          )}
          <ExportPanel />
        </div>
      </header>
      <div className="app-body">
        <MediaBin />
        <Preview />
      </div>
      <Timeline />
    </div>
  );
}

export default App;
