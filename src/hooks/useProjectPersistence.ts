import { useEffect, useRef } from "react";
import { useEditorStore } from "../store/editorStore";
import {
  createProject,
  deleteProject,
  getLastActiveProjectId,
  listProjects,
  loadProjectById,
  renameProject,
  saveProjectById,
  setLastActiveProjectId,
  type ProjectSummary,
} from "../lib/persistence";

const AUTOSAVE_DEBOUNCE_MS = 800;

/**
 * Resolves the project to open on startup, creating a default one only if
 * none exists. Cached at module scope (not component/effect scope) so
 * StrictMode's mount->cleanup->mount dev cycle can't race two concurrent
 * callers into each creating their own "Untitled Project".
 */
let initialProjectPromise: Promise<string> | null = null;
function resolveInitialProjectId(): Promise<string> {
  if (!initialProjectPromise) {
    initialProjectPromise = (async () => {
      const lastActive = await getLastActiveProjectId();
      if (lastActive) return lastActive;
      const projects = await listProjects();
      return projects[0]?.id ?? createProject("Untitled Project");
    })();
  }
  return initialProjectPromise;
}

/** Persists whatever autosave debounce is in flight so a project switch never loses pending edits. */
async function flushPendingSave(): Promise<void> {
  const s = useEditorStore.getState();
  if (!s.projectId) return;
  await saveProjectById(s.projectId, s.projectName, {
    tracks: s.tracks,
    clips: s.clips,
    zoom: s.zoom,
    sources: s.sources,
    transitions: s.transitions,
  });
}

/**
 * Loads the last-active project (or creates a default one) on mount, then
 * autosaves (debounced) whenever clips/tracks/sources/zoom change. Playhead/
 * playing/selection changes are intentionally excluded so playback doesn't
 * trigger writes on every animation frame.
 */
export function useProjectPersistence() {
  const hydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = await resolveInitialProjectId();
        const data = await loadProjectById(id);
        if (cancelled) return;
        if (data) {
          useEditorStore.getState().hydrate(data);
          await setLastActiveProjectId(id);
        }
      } catch (err) {
        console.error("Failed to load saved project", err);
      } finally {
        if (!cancelled) hydratedRef.current = true;
      }
    })();
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
        state.zoom !== prev.zoom ||
        state.projectName !== prev.projectName ||
        state.transitions !== prev.transitions;
      if (!changed) return;

      useEditorStore.getState().setSaveStatus("saving");
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(async () => {
        try {
          await flushPendingSave();
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

export async function getProjectList(): Promise<ProjectSummary[]> {
  return listProjects();
}

/** Switches the editor to a different saved project, flushing any pending autosave first. */
export async function switchProject(id: string): Promise<void> {
  await flushPendingSave();
  const data = await loadProjectById(id);
  if (!data) return;
  useEditorStore.getState().hydrate(data);
  await setLastActiveProjectId(id);
}

/** Creates a new empty project and switches to it. */
export async function createAndSwitchProject(name: string): Promise<void> {
  await flushPendingSave();
  const id = await createProject(name);
  await switchProject(id);
}

export async function renameCurrentProject(name: string): Promise<void> {
  const id = useEditorStore.getState().projectId;
  if (!id) return;
  useEditorStore.getState().setProjectName(name);
  await renameProject(id, name);
}

/** Deletes a project. If it's the current one, switches to another project (creating a default if none remain). */
export async function deleteProjectAndSwitchIfNeeded(id: string): Promise<void> {
  const currentId = useEditorStore.getState().projectId;
  await deleteProject(id);
  if (id !== currentId) return;

  const remaining = await listProjects();
  if (remaining.length > 0) {
    await switchProject(remaining[0].id);
  } else {
    const newId = await createProject("Untitled Project");
    await switchProject(newId);
  }
}
