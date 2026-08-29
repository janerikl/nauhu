import { useEffect } from "react";
import { MediaBin } from "./components/MediaBin";
import { TransitionsPanel } from "./components/TransitionsPanel";
import { Timeline } from "./components/Timeline";
import { Preview } from "./components/Preview";
import { ExportPanel } from "./components/ExportPanel";
import { ProjectMenu } from "./components/ProjectMenu";
import { useEditorStore } from "./store/editorStore";
import { useProjectPersistence } from "./hooks/useProjectPersistence";
import "./App.css";

function App() {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const selectedTransitionId = useEditorStore((s) => s.selectedTransitionId);
  const splitClipAtPlayhead = useEditorStore((s) => s.splitClipAtPlayhead);
  const removeClip = useEditorStore((s) => s.removeClip);
  const removeTransition = useEditorStore((s) => s.removeTransition);
  const saveStatus = useEditorStore((s) => s.saveStatus);

  useProjectPersistence();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) useEditorStore.getState().redo();
        else useEditorStore.getState().undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        useEditorStore.getState().redo();
      } else if (e.code === "Space") {
        e.preventDefault();
        useEditorStore.getState().setIsPlaying(!useEditorStore.getState().isPlaying);
      } else if (e.key === "Home") {
        e.preventDefault();
        useEditorStore.getState().setPlayhead(0);
        useEditorStore.getState().setIsPlaying(true);
      } else if (e.key === "s" && selectedClipId) {
        splitClipAtPlayhead(selectedClipId);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedClipId) removeClip(selectedClipId);
        else if (selectedTransitionId) removeTransition(selectedTransitionId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedClipId, selectedTransitionId, splitClipAtPlayhead, removeClip, removeTransition]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-left">
          <div className="app-brand">
            <svg width="20" height="20" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <rect width="32" height="32" rx="9" fill="var(--accent)" />
              <rect x="5.5" y="9" width="21" height="15" rx="2.2" fill="var(--accent-ink)" />
              <rect x="8.3" y="11.6" width="15.4" height="3.2" rx="1" fill="var(--accent)" />
              <circle cx="11.6" cy="19.6" r="3" fill="var(--accent)" />
              <circle cx="20.4" cy="19.6" r="3" fill="var(--accent)" />
              <circle cx="11.6" cy="19.6" r="1" fill="var(--accent-ink)" />
              <circle cx="20.4" cy="19.6" r="1" fill="var(--accent-ink)" />
            </svg>
            <h1>Nauhu</h1>
          </div>
          <ProjectMenu />
        </div>
        <div className="app-header-right">
          {saveStatus !== "idle" && (
            <span className="save-status">{saveStatus === "saving" ? "Saving…" : "Saved"}</span>
          )}
          <ExportPanel />
        </div>
      </header>
      <div className="app-body">
        <div className="sidebar">
          <MediaBin />
          <TransitionsPanel />
        </div>
        <Preview />
      </div>
      <Timeline />
    </div>
  );
}

export default App;
