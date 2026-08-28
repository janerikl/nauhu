import { useEffect, useRef } from "react";
import { useEditorStore } from "../store/editorStore";
import { loadProject, saveProject } from "../lib/persistence";

const AUTOSAVE_DEBOUNCE_MS = 800;

/**
 * Loads any previously saved project from IndexedDB on mount, then autosaves
 * (debounced) whenever clips/tracks/sources/zoom change. Playhead/playing/
 * selection changes are intentionally excluded so playback doesn't trigger
 * writes on every animation frame.
 */
export function useProjectPersistence() {
  const hydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadProject()
      .then((data) => {
        if (cancelled) return;
        if (data) useEditorStore.getState().hydrate(data);
      })
      .catch((err) => {
        console.error("Failed to load saved project", err);
      })
      .finally(() => {
        if (!cancelled) hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = useEditorStore.subscribe((state, prev) => {
      if (!hydratedRef.current) return;
      const changed =
        state.clips !== prev.clips ||
        state.tracks !== prev.tracks ||
        state.sources !== prev.sources ||
        state.zoom !== prev.zoom;
      if (!changed) return;

      useEditorStore.getState().setSaveStatus("saving");
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(async () => {
        const s = useEditorStore.getState();
        try {
          await saveProject({ tracks: s.tracks, clips: s.clips, zoom: s.zoom, sources: s.sources });
          useEditorStore.getState().setSaveStatus("saved");
        } catch (err) {
          console.error("Failed to save project", err);
        }
      }, AUTOSAVE_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timeout) clearTimeout(timeout);
    };
  }, []);
}
