import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Code2,
  Folder,
  FolderOpen,
  GitBranch,
  Plus,
  PanelRight,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { shortPath, workspaceNameFromPath } from "../lib/workspace";
import { useStore } from "../store";
import type { GitStatus, Workspace, WorkspaceTool } from "../types";

const MISSION_TEMPLATES = [
  {
    title: "Improve product workflow",
    goal: "Make the current project workflow clearer, easier to operate, and safer for users while preserving flexibility.",
    definitionOfDone: "The user can complete the workflow without guessing context, ownership, next steps, or success criteria.",
    constraints: "Prefer incremental changes that fit the existing architecture and avoid disrupting current project data.",
  },
  {
    title: "Build a feature end to end",
    goal: "Design, implement, verify, and document one focused product feature in this workspace.",
    definitionOfDone: "The feature works in the app, relevant edge cases are handled, verification passes, and docs or notes are updated.",
    constraints: "Keep changes scoped to the feature and follow existing code patterns.",
  },
  {
    title: "Fix a bug or regression",
    goal: "Identify the root cause of a bug, implement the smallest reliable fix, and verify the behavior.",
    definitionOfDone: "The bug is reproducible or clearly explained, fixed, and covered by an appropriate check or documented verification.",
    constraints: "Avoid broad refactors unless they are required to fix the issue safely.",
  },
  {
    title: "Review and harden",
    goal: "Review the current implementation for product gaps, safety risks, usability issues, and technical debt.",
    definitionOfDone: "Findings are prioritized, concrete fixes are proposed or implemented, and residual risks are documented.",
    constraints: "Focus on issues that affect real user workflows or system reliability.",
  },
] as const;

interface Props {
  cwd: string;
  activeWorkspaceId: string | null;
  workspaces: Workspace[];
  filesActive: boolean;
  onSelectWorkspace: (workspace: Workspace) => void;
  onAddWorkspace: (rootPath: string) => void;
  onRemoveWorkspace: (workspace: Workspace) => void;
  onTerminal: () => void;
  onShell: (tool: WorkspaceTool) => void;
  onToggleFiles: () => void;
}

export function WorkspaceToolbar({
  cwd,
  activeWorkspaceId,
  workspaces,
  filesActive,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onTerminal,
  onShell,
  onToggleFiles,
}: Props) {
  const [tools, setTools] = useState<WorkspaceTool[]>([]);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [toolOpen, setToolOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  useEffect(() => {
    api.workspaceTools().then(setTools).catch(() => setTools([]));
  }, []);

  useEffect(() => {
    if (!cwd) return;
    api.gitStatus(cwd).then(setGit).catch(() => setGit(null));
  }, [cwd]);

  const primaryTool = useMemo(
    () =>
      tools.find((t) => t.available && t.kind === "editor") ??
      tools.find((t) => t.available && t.id === "file_explorer") ??
      null,
    [tools],
  );
  const workspaceName = useMemo(() => workspaceNameFromPath(cwd), [cwd]);

  const openTool = async (tool: WorkspaceTool) => {
    setToolOpen(false);
    setGitOpen(false);
    if (tool.id === "terminal") {
      onTerminal();
      return;
    }
    if (tool.kind === "shell") {
      onShell(tool);
      return;
    }
    await api.workspaceOpenTool(tool.id, cwd).catch((e) => console.error(e));
  };

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <div className="relative hidden lg:block">
        <button
          onClick={() => {
            setWorkspaceOpen((v) => !v);
            setToolOpen(false);
            setGitOpen(false);
          }}
          className="h-8 max-w-72 items-center gap-2 rounded-md border border-(--color-accent-cyan)/25 bg-(--color-accent-cyan)/8 px-2.5 text-left flex"
          title={cwd}
        >
          <Folder size={14} className="text-(--color-accent-cyan) shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-base-200 truncate">{workspaceName}</div>
            <div className="text-[10px] text-base-500 font-mono truncate">
              {git?.branch ? `${git.branch} · ` : ""}
              {shortPath(cwd)}
            </div>
          </div>
          <ChevronDown size={13} className="text-base-500 shrink-0" />
        </button>
        {workspaceOpen && (
          <div className="absolute left-0 top-10 z-[240] w-80 rounded-lg border border-base-700 bg-base-950 shadow-2xl ring-1 ring-black/40 p-1.5">
            {workspaces.map((workspace) => (
              <div
                key={workspace.id}
                className={cn(
                  "group w-full rounded-md flex items-center gap-1 transition",
                  workspace.id === activeWorkspaceId
                    ? "bg-(--color-accent-cyan)/12 text-(--color-accent-cyan)"
                    : "text-base-200 hover:bg-base-800",
                )}
              >
                <button
                  onClick={() => {
                    setWorkspaceOpen(false);
                    onSelectWorkspace(workspace);
                  }}
                  className="min-w-0 flex-1 px-3 py-2 flex items-center gap-3 text-left"
                  title={workspace.root_path}
                >
                  <Folder size={14} className="shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm truncate">{workspace.name}</div>
                    <div className="text-[10px] text-base-500 font-mono truncate">
                      {shortPath(workspace.root_path)}
                    </div>
                  </div>
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    if (workspaces.length <= 1) return;
                    onRemoveWorkspace(workspace);
                  }}
                  disabled={workspaces.length <= 1}
                  className="mr-1 h-7 w-7 shrink-0 rounded-md text-base-600 opacity-0 transition hover:bg-base-700 hover:text-(--color-accent-red) disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-base-600 group-hover:opacity-100 focus:opacity-100"
                  title={workspaces.length <= 1 ? "Keep at least one workspace" : "Remove workspace from list"}
                >
                  <Trash2 size={13} className="mx-auto" />
                </button>
              </div>
            ))}
            <InlineWorkspaceAdder onSubmit={(path) => {
              setWorkspaceOpen(false);
              onAddWorkspace(path);
            }} />
          </div>
        )}
      </div>

      <MissionControl />

      <div className="relative">
        <div className="h-8 rounded-md border border-base-700/70 bg-base-900/80 flex overflow-hidden">
          <button
            onClick={() => primaryTool && openTool(primaryTool)}
            className="h-full px-2.5 flex items-center gap-2 text-base-300 hover:text-base-100 hover:bg-base-800/70 transition"
            title={primaryTool ? `Open in ${primaryTool.name}` : "No editor detected"}
            disabled={!primaryTool}
          >
            <ToolGlyph tool={primaryTool} />
            <span className="hidden 2xl:inline text-xs max-w-24 truncate">
              {primaryTool?.name ?? "Editor"}
            </span>
          </button>
          <button
            onClick={() => setToolOpen((v) => !v)}
            className="h-full w-8 border-l border-base-800 text-base-500 hover:text-base-200 hover:bg-base-800/70 transition flex items-center justify-center"
            title="Choose workspace tool"
          >
            <ChevronDown size={14} />
          </button>
        </div>

        {toolOpen && (
          <div className="absolute left-0 top-10 z-[220] w-64 rounded-lg border border-base-700 bg-base-950 shadow-2xl ring-1 ring-black/40 p-1.5">
            {tools.map((tool) => (
              <button
                key={tool.id}
                onClick={() => openTool(tool)}
                disabled={!tool.available}
                className={cn(
                  "w-full px-3 py-2 rounded-md flex items-center gap-3 text-left transition",
                  tool.available
                    ? "text-base-200 hover:bg-base-800"
                    : "text-base-600 cursor-not-allowed",
                )}
                title={tool.binary ?? "Not detected"}
              >
                <ToolGlyph tool={tool} />
                <div className="min-w-0">
                  <div className="text-sm truncate">{tool.name}</div>
                  {!tool.available && (
                    <div className="text-[10px] text-base-600">Not detected</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        <button
          onClick={() => {
            setToolOpen(false);
            setGitOpen((v) => !v);
          }}
          className="h-8 px-3 rounded-md border border-base-700/70 bg-base-900/80 text-base-400 hover:text-base-100 hover:bg-base-800/70 flex items-center gap-2 transition"
          title="Git status"
        >
          <GitBranch size={14} />
          <span className="hidden xl:inline text-xs">
            {git?.is_repo
              ? git.changed_count > 0
                ? `${git.changed_count} changed`
                : "Clean"
              : "No repo"}
          </span>
          <ChevronDown size={13} />
        </button>
        {gitOpen && (
          <div className="absolute left-0 top-10 z-[220] w-72 rounded-lg border border-base-700 bg-base-950 shadow-2xl ring-1 ring-black/40 p-3">
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="text-xs text-base-500">Commit</div>
              <button
                onClick={() => api.gitStatus(cwd).then(setGit).catch(() => setGit(null))}
                className="text-[11px] text-base-500 hover:text-base-200"
              >
                Refresh
              </button>
            </div>
            {!git?.is_repo ? (
              <div className="text-sm text-base-500">Workspace is not a git repository.</div>
            ) : (
              <>
                <div className="text-xs text-base-400 mb-2">
                  Branch: <span className="text-base-200">{git.branch ?? "(detached)"}</span>
                </div>
                <div className="max-h-52 overflow-auto rounded-md bg-base-950/70 border border-base-800 p-2 font-mono text-[11px] text-base-300">
                  {git.summary.length === 0 ? (
                    <div className="text-base-500">No local changes.</div>
                  ) : (
                    git.summary.map((line) => <div key={line}>{line}</div>)
                  )}
                </div>
                <button
                  onClick={() => {
                    setGitOpen(false);
                    onTerminal();
                  }}
                  className="mt-2 w-full h-8 rounded-md bg-base-800 hover:bg-base-700 text-xs text-base-200 transition"
                >
                  Open terminal for commit
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="h-6 w-px bg-base-800 mx-1" />
      <IconBtn
        icon={<SquareTerminal size={15} />}
        label="New terminal"
        onClick={onTerminal}
      />
      <IconBtn icon={<Folder size={15} />} label="Open File Explorer" onClick={() => api.openPathExternal(cwd)} />
      <IconBtn
        icon={<PanelRight size={15} />}
        label="File tree"
        active={filesActive}
        onClick={onToggleFiles}
      />
    </div>
  );
}

function IconBtn({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "h-8 w-8 rounded-md border flex items-center justify-center transition",
        active
          ? "bg-(--color-accent-cyan)/15 text-(--color-accent-cyan) border-(--color-accent-cyan)/30"
          : "text-base-400 border-transparent hover:text-base-100 hover:bg-base-800/60",
      )}
    >
      {icon}
    </button>
  );
}

function InlineWorkspaceAdder({ onSubmit }: { onSubmit: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const browse = async () => {
    setBusy(true);
    try {
      const selected = await api.pickWorkspaceFolder(path || null);
      if (selected) setPath(selected);
    } catch (e) {
      console.error("folder picker failed", e);
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-1 w-full px-3 py-2 rounded-md flex items-center gap-3 text-left text-base-400 hover:text-base-100 hover:bg-base-800 transition"
      >
        <Plus size={14} />
        <span className="text-sm">Add workspace</span>
      </button>
    );
  }
  return (
    <div className="mt-1 border-t border-base-800 pt-1.5 px-1">
      <input
        autoFocus
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && path.trim()) onSubmit(path.trim());
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="C:\\path\\to\\project"
        className="w-full bg-base-900 border border-base-700 rounded px-2 py-1.5 text-xs font-mono outline-none focus:border-(--color-accent-cyan)"
      />
      <div className="mt-1 flex justify-end gap-1">
        <button
          onClick={browse}
          disabled={busy}
          className="mr-auto px-2 py-1 text-[11px] rounded text-(--color-accent-cyan) hover:bg-(--color-accent-cyan)/10 disabled:opacity-40 flex items-center gap-1"
        >
          <FolderOpen size={11} /> Browse
        </button>
        <button
          onClick={() => setOpen(false)}
          className="px-2 py-1 text-[11px] rounded text-base-500 hover:bg-base-800"
        >
          Cancel
        </button>
        <button
          onClick={() => path.trim() && onSubmit(path.trim())}
          disabled={!path.trim()}
          className="px-2 py-1 text-[11px] rounded bg-(--color-accent-cyan)/20 text-(--color-accent-cyan) disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function MissionControl() {
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const missions = useStore((s) => s.missions);
  const setMissions = useStore((s) => s.setMissions);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [definitionOfDone, setDefinitionOfDone] = useState("");
  const [constraints, setConstraints] = useState("");
  if (!activeWorkspace) return null;
  const activeMission = missions.find((m) => m.id === activeWorkspace.active_mission_id) ?? null;
  const createMission = async () => {
    if (!title.trim() || !goal.trim()) return;
    const mission = await api.missionsSave({
      workspaceId: activeWorkspace.id,
      title: title.trim(),
      goal: goal.trim(),
      definitionOfDone: definitionOfDone.trim() || null,
      constraints: constraints.trim() || null,
      setActive: true,
    });
    const next = [mission, ...missions.filter((m) => m.id !== mission.id)];
    setMissions(next);
    useStore.getState().setActiveWorkspace({
      ...activeWorkspace,
      active_mission_id: mission.id,
    });
    setTitle("");
    setGoal("");
    setDefinitionOfDone("");
    setConstraints("");
    setOpen(false);
  };
  const selectMission = async (missionId: string | null) => {
    await api.missionsSetActive(activeWorkspace.id, missionId);
    useStore.getState().setActiveWorkspace({
      ...activeWorkspace,
      active_mission_id: missionId,
    });
    setOpen(false);
  };
  return (
    <div className="relative hidden xl:block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="h-8 max-w-56 rounded-md border border-base-700/70 bg-base-900/80 px-2.5 flex items-center gap-2 text-left hover:bg-base-800/70 transition"
        title={activeMission?.goal ?? "Workspace mission"}
      >
        <span className="text-[10px] uppercase tracking-wider text-base-500">Mission</span>
        <span className="text-xs text-base-200 truncate">
          {activeMission?.title ?? "None"}
        </span>
        <ChevronDown size={13} className="text-base-500 shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-[240] w-96 rounded-lg border border-base-700 bg-base-950 shadow-2xl ring-1 ring-black/40 p-2">
          <div className="max-h-44 overflow-auto space-y-1">
            <button
              onClick={() => selectMission(null)}
              className="w-full px-2 py-1.5 rounded text-left text-sm text-base-400 hover:bg-base-800"
            >
              No active mission
            </button>
            {missions.map((mission) => (
              <button
                key={mission.id}
                onClick={() => selectMission(mission.id)}
                className={cn(
                  "w-full px-2 py-1.5 rounded text-left transition",
                  mission.id === activeWorkspace.active_mission_id
                    ? "bg-(--color-accent-cyan)/12 text-(--color-accent-cyan)"
                    : "text-base-200 hover:bg-base-800",
                )}
              >
                <div className="text-sm truncate">{mission.title}</div>
                <div className="text-[10px] text-base-500 truncate">{mission.goal}</div>
              </button>
            ))}
          </div>
          <div className="mt-2 border-t border-base-800 pt-2 space-y-1.5">
            <div className="flex flex-wrap gap-1">
              {MISSION_TEMPLATES.map((template) => (
                <button
                  key={template.title}
                  onClick={() => {
                    setTitle(template.title);
                    setGoal(template.goal);
                    setDefinitionOfDone(template.definitionOfDone);
                    setConstraints(template.constraints);
                  }}
                  className="px-2 py-1 text-[10px] rounded border border-base-700/60 text-base-400 hover:text-(--color-accent-cyan) hover:border-(--color-accent-cyan)/40 hover:bg-(--color-accent-cyan)/10 transition"
                  title={template.goal}
                >
                  {template.title}
                </button>
              ))}
            </div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Mission title"
              className="w-full bg-base-900 border border-base-700 rounded px-2 py-1.5 text-xs outline-none focus:border-(--color-accent-cyan)"
            />
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Goal / definition of done"
              rows={2}
              className="w-full bg-base-900 border border-base-700 rounded px-2 py-1.5 text-xs outline-none resize-none focus:border-(--color-accent-cyan)"
            />
            <textarea
              value={definitionOfDone}
              onChange={(e) => setDefinitionOfDone(e.target.value)}
              placeholder="Definition of done (optional)"
              rows={2}
              className="w-full bg-base-900 border border-base-700 rounded px-2 py-1.5 text-xs outline-none resize-none focus:border-(--color-accent-cyan)"
            />
            <textarea
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
              placeholder="Constraints (optional)"
              rows={2}
              className="w-full bg-base-900 border border-base-700 rounded px-2 py-1.5 text-xs outline-none resize-none focus:border-(--color-accent-cyan)"
            />
            <button
              onClick={createMission}
              disabled={!title.trim() || !goal.trim()}
              className="w-full px-2 py-1.5 text-xs rounded bg-(--color-accent-cyan)/20 text-(--color-accent-cyan) disabled:opacity-40"
            >
              Create and activate mission
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolGlyph({ tool }: { tool: WorkspaceTool | null }) {
  if (!tool) return <Code2 size={17} className="text-base-500" />;
  if (tool.id === "vscode") return <Code2 size={17} className="text-[#3aa0ff]" />;
  if (tool.id === "cursor") return <Code2 size={17} className="text-base-200" />;
  if (tool.id === "visual_studio") return <Code2 size={17} className="text-[#a772ff]" />;
  if (tool.id === "file_explorer") return <Folder size={17} className="text-(--color-accent-amber)" />;
  if (tool.id === "terminal") return <SquareTerminal size={17} className="text-base-400" />;
  if (tool.id === "git_bash") return <GitBranch size={17} className="text-(--color-accent-green)" />;
  return <Code2 size={17} className="text-base-400" />;
}
