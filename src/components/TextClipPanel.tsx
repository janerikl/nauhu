import { useEditorStore } from "../store/editorStore";

const FONT_FAMILIES = ["sans-serif", "serif", "monospace"];

export function TextClipPanel() {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const clip = useEditorStore((s) => s.clips.find((c) => c.id === s.selectedClipId));
  const updateTextClip = useEditorStore((s) => s.updateTextClip);

  if (!selectedClipId || !clip?.text) return null;
  const style = clip.text;

  return (
    <div className="text-clip-panel">
      <span className="text-clip-panel-title">Text</span>
      <textarea
        className="text-clip-content"
        value={style.content}
        onChange={(e) => updateTextClip(clip.id, { content: e.target.value })}
        rows={2}
      />
      <label>
        Size
        <input
          type="number"
          min={8}
          max={300}
          value={style.fontSize}
          onChange={(e) => updateTextClip(clip.id, { fontSize: Number(e.target.value) || style.fontSize })}
        />
      </label>
      <label>
        Color
        <input
          type="color"
          value={style.color}
          onChange={(e) => updateTextClip(clip.id, { color: e.target.value })}
        />
      </label>
      <label>
        Font
        <select
          value={style.fontFamily}
          onChange={(e) => updateTextClip(clip.id, { fontFamily: e.target.value })}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label>
        Align
        <select
          value={style.align}
          onChange={(e) =>
            updateTextClip(clip.id, { align: e.target.value as "left" | "center" | "right" })
          }
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </label>
      <label>
        Position
        <select
          value={style.verticalAlign}
          onChange={(e) =>
            updateTextClip(clip.id, {
              verticalAlign: e.target.value as "top" | "middle" | "bottom",
            })
          }
        >
          <option value="top">Top</option>
          <option value="middle">Middle</option>
          <option value="bottom">Bottom</option>
        </select>
      </label>
      <label className="text-clip-fade">
        <input
          type="checkbox"
          checked={style.fadeIn > 0 || style.fadeOut > 0}
          onChange={(e) =>
            updateTextClip(clip.id, {
              fadeIn: e.target.checked ? 0.4 : 0,
              fadeOut: e.target.checked ? 0.4 : 0,
            })
          }
        />
        Fade in/out
      </label>
    </div>
  );
}
