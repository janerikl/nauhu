import { openDB, type IDBPDatabase } from "idb";
import type { Clip, Track, TimelineTransition } from "./timeline-math";
import type { HydrateData, MediaSource } from "../store/editorStore";

const DB_NAME = "videoeditor-db";
const DB_VERSION = 2;
const PROJECTS_STORE = "projects";
const MEDIA_STORE = "media";
const META_STORE = "meta";
const LAST_ACTIVE_KEY = "lastActiveProjectId";

// v1 store names, kept only for migration.
const V1_PROJECT_STORE = "project";
const V1_PROJECT_KEY = "current";

interface PersistedSourceMeta {
  id: string;
  name: string;
  duration: number;
  kind: "video" | "audio" | "image";
  folder: string;
}

export interface PersistedProject {
  id: string;
  name: string;
  updatedAt: number;
  tracks: Track[];
  clips: Clip[];
  zoom: number;
  sources: PersistedSourceMeta[];
  folders: string[];
  transitions: TimelineTransition[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
}

const DEFAULT_TRACKS: Track[] = [
  { id: "video-1", name: "Video", kind: "video" },
  { id: "audio-1", name: "Audio", kind: "audio" },
];

function newProjectId(): string {
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains(PROJECTS_STORE)) db.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE);
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);

        if (oldVersion < 2 && db.objectStoreNames.contains(V1_PROJECT_STORE)) {
          const legacy = (await tx.objectStore(V1_PROJECT_STORE).get(V1_PROJECT_KEY)) as
            | Omit<PersistedProject, "id" | "name" | "updatedAt">
            | undefined;
          if (legacy) {
            const id = newProjectId();
            const migrated: PersistedProject = {
              id,
              name: "Untitled Project",
              updatedAt: Date.now(),
              tracks: legacy.tracks,
              clips: legacy.clips,
              zoom: legacy.zoom,
              sources: legacy.sources,
              transitions: [],
            };
            await tx.objectStore(PROJECTS_STORE).put(migrated);
            await tx.objectStore(META_STORE).put(id, LAST_ACTIVE_KEY);
          }
          db.deleteObjectStore(V1_PROJECT_STORE);
        }
      },
    });
  }
  return dbPromise;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await getDB();
  const all = (await db.getAll(PROJECTS_STORE)) as PersistedProject[];
  return all
    .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createProject(name: string): Promise<string> {
  const db = await getDB();
  const id = newProjectId();
  const project: PersistedProject = {
    id,
    name,
    updatedAt: Date.now(),
    tracks: DEFAULT_TRACKS,
    clips: [],
    zoom: 60,
    sources: [],
    folders: [],
    transitions: [],
  };
  await db.put(PROJECTS_STORE, project);
  return id;
}

/** Saves a project's structure and any not-yet-saved media blobs. */
export async function saveProjectById(
  id: string,
  name: string,
  state: {
    tracks: Track[];
    clips: Clip[];
    zoom: number;
    sources: MediaSource[];
    folders: string[];
    transitions: TimelineTransition[];
  }
): Promise<void> {
  const db = await getDB();

  const project: PersistedProject = {
    id,
    name,
    updatedAt: Date.now(),
    tracks: state.tracks,
    clips: state.clips,
    zoom: state.zoom,
    sources: state.sources.map((s) => ({
      id: s.id,
      name: s.name,
      duration: s.duration,
      kind: s.kind,
      folder: s.folder,
    })),
    folders: state.folders,
    transitions: state.transitions,
  };

  const tx = db.transaction([PROJECTS_STORE, MEDIA_STORE], "readwrite");
  await tx.objectStore(PROJECTS_STORE).put(project);

  const mediaStore = tx.objectStore(MEDIA_STORE);
  for (const source of state.sources) {
    const existing = await mediaStore.getKey(source.id);
    if (existing === undefined) {
      await mediaStore.put(source.blob, source.id);
    }
  }

  await tx.done;
}

/** Loads a project by id, reconstructing object URLs for each source's blob. */
export async function loadProjectById(id: string): Promise<(HydrateData & { id: string; name: string }) | null> {
  const db = await getDB();
  const project = (await db.get(PROJECTS_STORE, id)) as PersistedProject | undefined;
  if (!project) return null;

  const sources: MediaSource[] = [];
  for (const meta of project.sources) {
    const blob = (await db.get(MEDIA_STORE, meta.id)) as Blob | undefined;
    if (!blob) continue; // media missing (e.g. cleared storage) - skip, keep the rest of the project usable
    // Projects saved before image import support tagged image files as
    // "video" (the only non-audio kind that existed then); fix that up here
    // so old projects get real image playback instead of a stalled <video>.
    const kind = meta.kind === "video" && blob.type.startsWith("image") ? "image" : meta.kind;
    const folder = meta.folder ?? "Ungrouped";
    sources.push({ ...meta, kind, folder, blob, url: URL.createObjectURL(blob) });
  }

  return {
    id: project.id,
    name: project.name,
    tracks: project.tracks,
    clips: project.clips,
    zoom: project.zoom,
    sources,
    folders: project.folders ?? [],
    transitions: project.transitions ?? [],
  };
}

export async function renameProject(id: string, name: string): Promise<void> {
  const db = await getDB();
  const project = (await db.get(PROJECTS_STORE, id)) as PersistedProject | undefined;
  if (!project) return;
  await db.put(PROJECTS_STORE, { ...project, name, updatedAt: Date.now() });
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(PROJECTS_STORE, id);
}

export async function getLastActiveProjectId(): Promise<string | null> {
  const db = await getDB();
  const id = (await db.get(META_STORE, LAST_ACTIVE_KEY)) as string | undefined;
  return id ?? null;
}

export async function setLastActiveProjectId(id: string): Promise<void> {
  const db = await getDB();
  await db.put(META_STORE, id, LAST_ACTIVE_KEY);
}
