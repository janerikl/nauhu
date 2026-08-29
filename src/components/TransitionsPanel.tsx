import { TRANSITION_DND_TYPE, TRANSITION_LABELS, type TransitionType } from "../lib/timeline-math";
import { Shuffle } from "lucide-react";

export function TransitionsPanel() {
  return (
    <div className="transitions-panel">
      <div className="transitions-panel-header">
        <span>Transitions</span>
      </div>
      <div className="transitions-panel-list">
        {(Object.entries(TRANSITION_LABELS) as [TransitionType, string][]).map(([type, label]) => (
          <div
            key={type}
            className="transition-item"
            draggable
            onDragStart={(e) => e.dataTransfer.setData(TRANSITION_DND_TYPE, type)}
            title="Drag onto a clip boundary in the timeline"
          >
            <Shuffle size={14} />
            <span className="transition-item-name">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
