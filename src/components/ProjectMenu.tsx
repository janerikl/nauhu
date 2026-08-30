import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../store/editorStore";
import {
  createAndSwitchProject,
  deleteProjectAndSwitchIfNeeded,
  getProjectList,
  renameCurrentProject,
  switchProject,
} from "../hooks/useProjectPersistence";
import type { ProjectSummary } from "../lib/persistence";
import { ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";

export function ProjectMenu() {
  const projectId = useEditorStore((s) => s.projectId);
  const projectName = useEditorStore((s) => s.projectName);
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(projectName);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    getProjectList().then(setProjects).catch(console.error);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open) setPendingDeleteId(null);
  }, [open]);

  const refreshList = () => getProjectList().then(setProjects).catch(console.error);

  const handleSwitch = async (id: string) => {
    if (id === projectId) {
      setOpen(false);
      return;
    }
    await switchProject(id);
    setOpen(false);
  };

  const handleNew = async () => {
    await createAndSwitchProject("Untitled Project");
    setOpen(false);
  };

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingDeleteId(id);
  };

  const confirmDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!pendingDeleteId) return;
    await deleteProjectAndSwitchIfNeeded(pendingDeleteId);
    setPendingDeleteId(null);
    refreshList();
  };

  const cancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingDeleteId(null);
  };

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraftName(projectName);
    setRenaming(true);
  };

  const commitRename = async () => {
    setRenaming(false);
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== projectName) {
      await renameCurrentProject(trimmed);
      refreshList();
    }
  };

  return (
    <div className="project-menu" ref={rootRef}>
      <button className="project-menu-trigger" onClick={() => setOpen((v) => !v)}>
        {renaming ? (
          <input
            autoFocus
            className="project-menu-rename-input"
            value={draftName}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="project-menu-name">{projectName}</span>
        )}
        <Pencil size={12} className="project-menu-edit-icon" onClick={startRename} />
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="project-menu-dropdown">
          <button className="project-menu-item project-menu-new" onClick={handleNew}>
            <Plus size={14} /> New Project
          </button>
          <div className="project-menu-divider" />
          {projects.map((p) => (
            <div
              key={p.id}
              className={`project-menu-item project-menu-row${p.id === projectId ? " active" : ""}`}
              onClick={() => handleSwitch(p.id)}
            >
              {pendingDeleteId === p.id ? (
                <div className="project-menu-confirm">
                  <span className="project-menu-confirm-label">Delete?</span>
                  <button className="project-menu-confirm-yes" onClick={confirmDelete}>
                    Yes
                  </button>
                  <button className="project-menu-confirm-no" onClick={cancelDelete}>
                    No
                  </button>
                </div>
              ) : (
                <>
                  <span className="project-menu-row-name">{p.name}</span>
                  <button
                    className="project-menu-delete"
                    title="Delete project"
                    onClick={(e) => handleDeleteClick(p.id, e)}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
