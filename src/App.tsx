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
          <h1>Web Video Editor</h1>
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
