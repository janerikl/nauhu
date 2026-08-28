import { openDB, type IDBPDatabase } from "idb";
import type { Clip, Track } from "./timeline-math";
import type { HydrateData, MediaSource } from "../store/editorStore";

const DB_NAME = "videoeditor-db";
const DB_VERSION = 1;
const PROJECT_STORE = "project";
const MEDIA_STORE = "media";
const PROJECT_KEY = "current";

interface PersistedSourceMeta {
  id: string;
  name: string;
  duration: number;
  kind: "video" | "audio";
}

interface PersistedProject {
  tracks: Track[];
  clips: Clip[];
  zoom: number;
  sources: PersistedSourceMeta[];
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(PROJECT_STORE)) db.createObjectStore(PROJECT_STORE);
        if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE);
      },
    });
  }
  return dbPromise;
}

/** Saves project structure (tracks/clips/zoom/source metadata) and any not-yet-saved media blobs. */
export async function saveProject(state: {
  tracks: Track[];
  clips: Clip[];
  zoom: number;
  sources: MediaSource[];
}): Promise<void> {
  const db = await getDB();

  const project: PersistedProject = {
    tracks: state.tracks,
    clips: state.clips,
    zoom: state.zoom,
    sources: state.sources.map((s) => ({ id: s.id, name: s.name, duration: s.duration, kind: s.kind })),
  };

  const tx = db.transaction([PROJECT_STORE, MEDIA_STORE], "readwrite");
  await tx.objectStore(PROJECT_STORE).put(project, PROJECT_KEY);

  const mediaStore = tx.objectStore(MEDIA_STORE);
  for (const source of state.sources) {
    const existing = await mediaStore.getKey(source.id);
    if (existing === undefined) {
      await mediaStore.put(source.blob, source.id);
    }
  }

  await tx.done;
}

/** Loads the saved project, if any, reconstructing object URLs for each source's blob. */
export async function loadProject(): Promise<HydrateData | null> {
  const db = await getDB();
  const project = (await db.get(PROJECT_STORE, PROJECT_KEY)) as PersistedProject | undefined;
  if (!project) return null;

  const sources: MediaSource[] = [];
  for (const meta of project.sources) {
    const blob = (await db.get(MEDIA_STORE, meta.id)) as Blob | undefined;
    if (!blob) continue; // media missing (e.g. cleared storage) - skip, keep the rest of the project usable
    sources.push({ ...meta, blob, url: URL.createObjectURL(blob) });
  }

  return { tracks: project.tracks, clips: project.clips, zoom: project.zoom, sources };
}

/** Clears all saved project data and media. */
export async function clearProject(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction([PROJECT_STORE, MEDIA_STORE], "readwrite");
  await tx.objectStore(PROJECT_STORE).clear();
  await tx.objectStore(MEDIA_STORE).clear();
  await tx.done;
}
