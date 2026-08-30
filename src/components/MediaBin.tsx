import { useCallback, useRef, useState } from "react";
import { useEditorStore } from "../store/editorStore";
import { Film, Upload, Loader2, X } from "lucide-react";
import { ensurePlayableVideo } from "../lib/transcode";

const DEFAULT_IMAGE_DURATION = 5;

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

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      for (const file of Array.from(files)) {
        const kind = file.type.startsWith("audio")
          ? "audio"
          : file.type.startsWith("image")
            ? "image"
            : "video";

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
          blob: playableFile,
        });
      }
    },
    [addSource]
  );

  const onDragStart = (e: React.DragEvent, sourceId: string) => {
    e.dataTransfer.setData("application/x-source-id", sourceId);
  };

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
            {sources.map((s) => (
            <div
              key={s.id}
              className="media-item"
              draggable
              onDragStart={(e) => onDragStart(e, s.id)}
              title={`Drag onto timeline\n${s.name}`}
            >
              <Film size={14} />
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
            ))}
          </>
        )}
      </div>
    </div>
  );
}
