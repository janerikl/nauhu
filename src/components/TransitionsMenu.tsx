import { useEffect, useRef, useState } from "react";
import { TRANSITION_DND_TYPE, TRANSITION_LABELS, type TransitionType } from "../lib/timeline-math";
import { Shuffle, ChevronDown } from "lucide-react";

export function TransitionsMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div className="transitions-menu" ref={rootRef}>
      <button className="btn-icon" onClick={() => setOpen((v) => !v)} title="Transitions">
        <Shuffle size={14} /> Transitions <ChevronDown size={12} />
      </button>
      {open && (
        <div className="transitions-menu-dropdown">
          {(Object.entries(TRANSITION_LABELS) as [TransitionType, string][]).map(([type, label]) => (
            <div
              key={type}
              className="transition-item"
              draggable
              onDragStart={(e) => e.dataTransfer.setData(TRANSITION_DND_TYPE, type)}
              // Closing on dragend (rather than dragstart) avoids unmounting
              // the dragged node while the browser's native drag is live.
              onDragEnd={() => setOpen(false)}
              title="Drag onto a clip boundary in the timeline"
            >
              <Shuffle size={14} />
              <span className="transition-item-name">{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
