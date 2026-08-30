import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorStore, type MediaSource } from "../store/editorStore";
import { Image, Video, Music, Upload, Loader2, X, ChevronRight, ChevronDown } from "lucide-react";
import { ensurePlayableVideo } from "../lib/transcode";

const DEFAULT_IMAGE_DURATION = 5;
const DEFAULT_FOLDER = "Ungrouped";
const COLLAPSED_FOLDERS_KEY = "media-bin-collapsed-folders";

const KIND_ICONS = { video: Video, audio: Music, image: Image } as const;

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

export function MediaBin() {
  const sources = useEditorStore((s) => s.sources);
  const addSource = useEditorStore((s) => s.addSource);
  const removeSource = useEditorStore((s) => s.removeSource);
  const inputRef = useRef<HTMLInputElement>(null);
  const [convertingNames, setConvertingNames] = useState<Set<string>>(new Set());
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [folderChoice, setFolderChoice] = useState(DEFAULT_FOLDER);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(loadCollapsedFolders);

  useEffect(() => {
    localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify(Array.from(collapsedFolders)));
  }, [collapsedFolders]);

  const existingFolders = Array.from(new Set(sources.map((s) => s.folder))).sort((a, b) =>
    a.localeCompare(b)
  );

  const importFiles = useCallback(
    async (files: File[], folder: string) => {
      for (const file of files) {
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
        addSource({
          id: `src-${Math.random().toString(36).slice(2, 9)}`,
          name: file.name,
          url,
          duration,
          kind,
          folder,
          blob: playableFile,
        });
      }
    },
    [addSource]
  );

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPendingFiles(Array.from(files));
    setFolderChoice(DEFAULT_FOLDER);
  }, []);

  const confirmImport = () => {
    if (!pendingFiles) return;
    const folder = folderChoice.trim() || DEFAULT_FOLDER;
    importFiles(pendingFiles, folder);
    setPendingFiles(null);
  };

  const toggleFolder = (folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const onDragStart = (e: React.DragEvent, sourceId: string) => {
    e.dataTransfer.setData("application/x-source-id", sourceId);
  };

  const groups = new Map<string, MediaSource[]>();
  for (const s of sources) {
    const list = groups.get(s.folder) ?? [];
    list.push(s);
    groups.set(s.folder, list);
  }
  const folderNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

  return (
    <div className="media-bin">
      <div className="media-bin-header">
        <span>Media</span>
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
      {pendingFiles && (
        <div className="media-import-prompt">
          <label htmlFor="media-folder-input">
            Add {pendingFiles.length} file{pendingFiles.length > 1 ? "s" : ""} to folder:
          </label>
          <input
            id="media-folder-input"
            list="media-folder-options"
            value={folderChoice}
            onChange={(e) => setFolderChoice(e.target.value)}
            placeholder={DEFAULT_FOLDER}
            autoFocus
          />
          <datalist id="media-folder-options">
            {existingFolders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <div className="media-import-actions">
            <button className="btn-icon" onClick={() => setPendingFiles(null)}>
              Cancel
            </button>
            <button className="btn-primary" onClick={confirmImport}>
              Add
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
      >
        {sources.length === 0 && convertingNames.size === 0 ? (
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
            {folderNames.map((folder) => {
              const collapsed = collapsedFolders.has(folder);
              const items = groups.get(folder)!;
              return (
                <div key={folder} className="media-folder">
                  <button className="media-folder-header" onClick={() => toggleFolder(folder)}>
                    {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <span className="media-folder-name">{folder}</span>
                    <span className="media-folder-count">{items.length}</span>
                  </button>
                  {!collapsed &&
                    items.map((s) => {
                      const Icon = KIND_ICONS[s.kind];
                      return (
                        <div
                          key={s.id}
                          className="media-item"
                          draggable
                          onDragStart={(e) => onDragStart(e, s.id)}
                          title={`Drag onto timeline\n${s.name}`}
                        >
                          <Icon size={14} />
                          <span className="media-item-name">{s.name}</span>
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
    </div>
  );
}
