import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditorStore, type MediaSource } from "../store/editorStore";
import {
  Image,
  Video,
  Music,
  Upload,
  Loader2,
  X,
  ChevronRight,
  ChevronDown,
  FolderPlus,
  Search,
  ArrowUpDown,
  Pencil,
  Trash2,
  FolderInput,
  FolderMinus,
  CircleDot,
  RefreshCw,
} from "lucide-react";
import { ensurePlayableVideo } from "../lib/transcode";

const DEFAULT_IMAGE_DURATION = 5;
const DEFAULT_FOLDER = "Ungrouped";
const COLLAPSED_FOLDERS_KEY = "media-bin-collapsed-folders";
const SOURCE_DRAG_TYPE = "application/x-source-id";

const KIND_ICONS = { video: Video, audio: Music, image: Image } as const;

type SortKey = "name" | "duration" | "kind" | "date";
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "date", label: "Date added" },
  { key: "name", label: "Name" },
  { key: "duration", label: "Duration" },
  { key: "kind", label: "Kind" },
];

function loadCollapsedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FOLDERS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".flac", ".weba", ".opus"];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"];

/** Classifies a file's media kind. Browsers report an empty or generic MIME
 * type (e.g. "application/octet-stream") for some containers - notably
 * .m4a on several platforms - so a filename-extension fallback catches what
 * `file.type` misses instead of silently misrouting the file as video. */
function detectMediaKind(file: File): "audio" | "image" | "video" {
  if (file.type.startsWith("audio")) return "audio";
  if (file.type.startsWith("image")) return "image";
  if (file.type.startsWith("video")) return "video";
  const name = file.name.toLowerCase();
  if (AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext))) return "audio";
  if (IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext))) return "image";
  return "video";
}

function loadMediaDuration(url: string, kind: "video" | "audio"): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement(kind === "audio" ? "audio" : "video");
    el.preload = "metadata";
    el.src = url;
    el.onloadedmetadata = () => resolve(el.duration);
    el.onerror = () => resolve(0);
  });
}

/** Grabs a mid-point frame from a video file as a small JPEG data URL for use as a thumbnail. */
function captureVideoThumbnail(url: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    const finish = (result: string | undefined) => {
      clearTimeout(timeout);
      video.onseeked = null;
      video.onerror = null;
      resolve(result);
    };
    const timeout = setTimeout(() => finish(undefined), 4000);
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish(undefined);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL("image/jpeg", 0.85));
      } catch {
        finish(undefined);
      }
    };
    video.onerror = () => finish(undefined);
  });
}

interface ContextMenuState {
  x: number;
  y: number;
  sourceId: string;
}

interface HoverPreviewState {
  x: number;
  y: number;
  thumbnail: string;
}

export function MediaBin() {
  const sources = useEditorStore((s) => s.sources);
  const folders = useEditorStore((s) => s.folders);
  const clips = useEditorStore((s) => s.clips);
  const addSource = useEditorStore((s) => s.addSource);
  const removeSource = useEditorStore((s) => s.removeSource);
  const addFolder = useEditorStore((s) => s.addFolder);
  const renameFolder = useEditorStore((s) => s.renameFolder);
  const removeFolder = useEditorStore((s) => s.removeFolder);
  const moveSourceToFolder = useEditorStore((s) => s.moveSourceToFolder);
  const renameSource = useEditorStore((s) => s.renameSource);
  const reorderSource = useEditorStore((s) => s.reorderSource);
  const updateSourceThumbnail = useEditorStore((s) => s.updateSourceThumbnail);
  const inputRef = useRef<HTMLInputElement>(null);
  const [convertingNames, setConvertingNames] = useState<Set<string>>(new Set());
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(loadCollapsedFolders);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [dragOverSourceId, setDragOverSourceId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState("");
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState | null>(null);

  const usedSourceIds = useMemo(() => new Set(clips.map((c) => c.sourceId)), [clips]);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify(Array.from(collapsedFolders)));
  }, [collapsedFolders]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      for (const file of Array.from(files)) {
        const kind = detectMediaKind(file);

        let playableFile: File | Blob = file;
        if (kind === "video") {
          playableFile = await ensurePlayableVideo(file, (status) => {
            setConvertingNames((prev) => {
              const next = new Set(prev);
              if (status === "converting") next.add(file.name);
              else next.delete(file.name);
              return next;
            });
          });
        }

        const url = URL.createObjectURL(playableFile);
        const duration =
          kind === "image" ? DEFAULT_IMAGE_DURATION : await loadMediaDuration(url, kind);
        const thumbnail = kind === "image" ? url : kind === "video" ? await captureVideoThumbnail(url) : undefined;
        addSource({
          id: `src-${Math.random().toString(36).slice(2, 9)}`,
          name: file.name,
          url,
          duration,
          kind,
          folder: DEFAULT_FOLDER,
          thumbnail,
          addedAt: Date.now(),
          blob: playableFile,
        });
      }
    },
    [addSource]
  );

  const confirmNewFolder = () => {
    const name = newFolderName.trim();
    if (name) addFolder(name);
    setNewFolderName("");
    setCreatingFolder(false);
  };

  const toggleFolder = (folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const startRenameSource = (source: MediaSource) => {
    setRenamingId(source.id);
    setRenamingValue(source.name);
    setContextMenu(null);
  };

  const commitRenameSource = () => {
    if (renamingId) renameSource(renamingId, renamingValue);
    setRenamingId(null);
  };

  const regenerateThumbnail = async (source: MediaSource) => {
    setContextMenu(null);
    const thumbnail =
      source.kind === "image" ? source.url : await captureVideoThumbnail(source.url);
    if (thumbnail) updateSourceThumbnail(source.id, thumbnail);
  };

  const startRenameFolder = (folder: string) => {
    setRenamingFolder(folder);
    setRenamingValue(folder);
  };

  const commitRenameFolder = () => {
    if (renamingFolder) renameFolder(renamingFolder, renamingValue);
    setRenamingFolder(null);
  };

  const toggleSelected = (sourceId: string, additive: boolean) => {
    setSelectedIds((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  const deleteSelected = () => {
    for (const id of selectedIds) removeSource(id);
    setSelectedIds(new Set());
  };

  const moveSelectedToFolder = (folder: string) => {
    for (const id of selectedIds) moveSourceToFolder(id, folder);
    setSelectedIds(new Set());
  };

  const onDragStart = (e: React.DragEvent, sourceId: string) => {
    e.dataTransfer.setData(SOURCE_DRAG_TYPE, sourceId);
  };

  const onFolderDrop = (e: React.DragEvent, folder: string) => {
    e.preventDefault();
    setDragOverFolder(null);
    setDragOverSourceId(null);
    const sourceId = e.dataTransfer.getData(SOURCE_DRAG_TYPE);
    if (sourceId) moveSourceToFolder(sourceId, folder);
  };

  const onItemDrop = (e: React.DragEvent, folder: string, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolder(null);
    setDragOverSourceId(null);
    const sourceId = e.dataTransfer.getData(SOURCE_DRAG_TYPE);
    if (!sourceId || sourceId === targetId) return;
    moveSourceToFolder(sourceId, folder);
    reorderSource(sourceId, targetId);
  };

  const query = searchQuery.trim().toLowerCase();
  const filtered = query ? sources.filter((s) => s.name.toLowerCase().includes(query)) : sources;

  const groups = new Map<string, MediaSource[]>();
  for (const folder of folders) groups.set(folder, []);
  for (const s of filtered) {
    const list = groups.get(s.folder) ?? [];
    list.push(s);
    groups.set(s.folder, list);
  }

  const sortItems = (items: MediaSource[]) =>
    [...items].sort((a, b) => {
      switch (sortBy) {
        case "name":
          return a.name.localeCompare(b.name);
        case "duration":
          return a.duration - b.duration;
        case "kind":
          return a.kind.localeCompare(b.kind);
        case "date":
        default:
          return a.addedAt - b.addedAt;
      }
    });

  let folderNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  if (query) folderNames = folderNames.filter((f) => (groups.get(f) ?? []).length > 0);

  const contextSource = contextMenu ? sources.find((s) => s.id === contextMenu.sourceId) : undefined;

  return (
    <div className="media-bin">
      <div className="media-bin-header">
        <span>Media</span>
        <button className="btn-icon" onClick={() => setCreatingFolder(true)} title="New folder">
          <FolderPlus size={14} />
        </button>
        <button className="btn-icon" onClick={() => inputRef.current?.click()} title="Import media">
          <Upload size={14} />
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="video/*,audio/*,image/*"
          multiple
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
      <div className="media-bin-toolbar">
        <div className="media-bin-search">
          <Search size={12} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search media…"
            aria-label="Search media"
          />
        </div>
        <div className="media-bin-sort">
          <ArrowUpDown size={12} />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            aria-label="Sort media"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {selectedIds.size > 0 && (
        <div className="media-bulk-bar">
          <span>{selectedIds.size} selected</span>
          <select
            defaultValue=""
            aria-label="Move selected to folder"
            onChange={(e) => {
              if (e.target.value) moveSelectedToFolder(e.target.value);
            }}
          >
            <option value="" disabled>
              Move to…
            </option>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <button className="btn-icon" title="Delete selected" onClick={deleteSelected}>
            <Trash2 size={14} />
          </button>
          <button className="btn-icon" title="Clear selection" onClick={() => setSelectedIds(new Set())}>
            <X size={14} />
          </button>
        </div>
      )}
      {creatingFolder && (
        <div className="media-import-prompt">
          <label htmlFor="media-new-folder-input">Folder name:</label>
          <input
            id="media-new-folder-input"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmNewFolder();
              if (e.key === "Escape") {
                setNewFolderName("");
                setCreatingFolder(false);
              }
            }}
            placeholder="New folder"
            autoFocus
          />
          <div className="media-import-actions">
            <button
              className="btn-icon"
              onClick={() => {
                setNewFolderName("");
                setCreatingFolder(false);
              }}
            >
              Cancel
            </button>
            <button className="btn-primary" onClick={confirmNewFolder}>
              Create
            </button>
          </div>
        </div>
      )}
      <div
        className="media-bin-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
        onScroll={() => setHoverPreview(null)}
      >
        {sources.length === 0 && convertingNames.size === 0 && folderNames.length === 0 ? (
          <div className="media-bin-empty">Drop video/audio files here or click Import</div>
        ) : (
          <>
            {Array.from(convertingNames).map((name) => (
              <div key={name} className="media-item media-item-converting" title={`Converting ${name}…`}>
                <Loader2 size={14} className="spin" />
                <span className="media-item-name">{name}</span>
                <span className="media-item-duration">Converting…</span>
              </div>
            ))}
            {folderNames.length === 0 && query && (
              <div className="media-bin-empty">No media matches "{searchQuery}"</div>
            )}
            {folderNames.map((folder) => {
              const collapsed = collapsedFolders.has(folder);
              const items = sortItems(groups.get(folder)!);
              return (
                <div key={folder} className="media-folder">
                  <div
                    className={
                      "media-folder-header" + (dragOverFolder === folder ? " media-folder-header-dragover" : "")
                    }
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverFolder(folder);
                    }}
                    onDragLeave={() => setDragOverFolder((f) => (f === folder ? null : f))}
                    onDrop={(e) => onFolderDrop(e, folder)}
                  >
                    <button className="media-folder-toggle" onClick={() => toggleFolder(folder)}>
                      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                    {renamingFolder === folder ? (
                      <input
                        className="media-folder-rename-input"
                        value={renamingValue}
                        autoFocus
                        onChange={(e) => setRenamingValue(e.target.value)}
                        onBlur={commitRenameFolder}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRenameFolder();
                          if (e.key === "Escape") setRenamingFolder(null);
                        }}
                      />
                    ) : (
                      <span
                        className="media-folder-name"
                        onClick={() => toggleFolder(folder)}
                        onDoubleClick={() => folder !== DEFAULT_FOLDER && startRenameFolder(folder)}
                      >
                        {folder}
                      </span>
                    )}
                    <span className="media-folder-count">{items.length}</span>
                    {folder !== DEFAULT_FOLDER && (
                      <>
                        <button
                          className="btn-icon"
                          title="Rename folder"
                          onClick={() => startRenameFolder(folder)}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="btn-icon"
                          title="Delete folder (moves items to Ungrouped)"
                          onClick={() => removeFolder(folder)}
                        >
                          <FolderMinus size={12} />
                        </button>
                      </>
                    )}
                  </div>
                  {!collapsed &&
                    items.map((s) => {
                      const Icon = KIND_ICONS[s.kind];
                      const selected = selectedIds.has(s.id);
                      return (
                        <div
                          key={s.id}
                          className={
                            "media-item" +
                            (selected ? " media-item-selected" : "") +
                            (dragOverSourceId === s.id ? " media-item-dragover" : "")
                          }
                          draggable
                          onDragStart={(e) => onDragStart(e, s.id)}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDragOverSourceId(s.id);
                          }}
                          onDragLeave={() => setDragOverSourceId((id) => (id === s.id ? null : id))}
                          onDrop={(e) => onItemDrop(e, folder, s.id)}
                          onClick={(e) => {
                            if (e.metaKey || e.ctrlKey || e.shiftKey) toggleSelected(s.id, true);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setContextMenu({ x: e.clientX, y: e.clientY, sourceId: s.id });
                          }}
                          title={`Drag onto timeline\n${s.name}`}
                        >
                          <input
                            type="checkbox"
                            className="media-item-checkbox"
                            checked={selected}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelected(s.id, true)}
                          />
                          {s.thumbnail ? (
                            <img
                              className="media-item-thumb"
                              src={s.thumbnail}
                              alt=""
                              onMouseEnter={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                setHoverPreview({ x: rect.left, y: rect.top, thumbnail: s.thumbnail! });
                              }}
                              onMouseLeave={() => setHoverPreview(null)}
                            />
                          ) : (
                            <Icon size={14} />
                          )}
                          {renamingId === s.id ? (
                            <input
                              className="media-item-rename-input"
                              value={renamingValue}
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setRenamingValue(e.target.value)}
                              onBlur={commitRenameSource}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitRenameSource();
                                if (e.key === "Escape") setRenamingId(null);
                              }}
                            />
                          ) : (
                            <span
                              className="media-item-name"
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                startRenameSource(s);
                              }}
                            >
                              {s.name}
                            </span>
                          )}
                          {usedSourceIds.has(s.id) && (
                            <span className="media-item-used" title="Used in timeline">
                              <CircleDot size={10} />
                            </span>
                          )}
                          <span className="media-item-duration">{s.duration.toFixed(1)}s</span>
                          <button
                            className="btn-icon media-item-remove"
                            title="Remove from media bin"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeSource(s.id);
                            }}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </>
        )}
      </div>
      {contextMenu && contextSource && (
        <div
          className="media-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => startRenameSource(contextSource)}>
            <Pencil size={12} /> Rename
          </button>
          <button onClick={() => regenerateThumbnail(contextSource)}>
            <RefreshCw size={12} /> Regenerate thumbnail
          </button>
          <div className="media-context-menu-submenu-label">
            <FolderInput size={12} /> Move to
          </div>
          {folders.map((f) => (
            <button
              key={f}
              className="media-context-menu-indent"
              disabled={f === contextSource.folder}
              onClick={() => {
                moveSourceToFolder(contextSource.id, f);
                setContextMenu(null);
              }}
            >
              {f}
            </button>
          ))}
          <button
            className="media-context-menu-danger"
            onClick={() => {
              removeSource(contextSource.id);
              setContextMenu(null);
            }}
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
      {hoverPreview && (
        <img
          className="media-item-thumb-preview"
          src={hoverPreview.thumbnail}
          alt=""
          style={{ left: hoverPreview.x, top: hoverPreview.y }}
        />
      )}
    </div>
  );
}
