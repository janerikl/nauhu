import { useCallback, useRef } from "react";
import { useEditorStore } from "../store/editorStore";
import { Film, Upload } from "lucide-react";

function loadMediaDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = url;
    v.onloadedmetadata = () => resolve(v.duration);
    v.onerror = () => resolve(0);
  });
}

export function MediaBin() {
  const sources = useEditorStore((s) => s.sources);
  const addSource = useEditorStore((s) => s.addSource);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      for (const file of Array.from(files)) {
        const url = URL.createObjectURL(file);
        const duration = await loadMediaDuration(url);
        addSource({
          id: `src-${Math.random().toString(36).slice(2, 9)}`,
          name: file.name,
          url,
          duration,
          kind: file.type.startsWith("audio") ? "audio" : "video",
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
          accept="video/*,audio/*"
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
        {sources.length === 0 ? (
          <div className="media-bin-empty">Drop video/audio files here or click Import</div>
        ) : (
          sources.map((s) => (
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
            </div>
          ))
        )}
      </div>
    </div>
  );
}
