import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  LayoutGrid,
  Network,
  Eye,
  Zap,
  Code2,
  Files,
  GitBranch,
  Plus,
  X,
  PanelBottomClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { SpawnDialog } from "./components/SpawnDialog";
import { SettingsDialog, applyTheme } from "./components/SettingsDialog";
import { WorkspaceToolbar } from "./components/WorkspaceToolbar";
import { useStore } from "./store";
import { api } from "./lib/api";
import { compactAgent } from "./lib/compact";
import {
  isInsideWorkspace,
  shortPath,
  workspaceContextFromWorkspace,
  workspaceNameFromPath,
} from "./lib/workspace";
import type { AgentEvent, HistoryAgent, Workspace, WorkspaceTool } from "./types";
import { cn } from "./lib/cn";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const EditorTile = lazy(() =>
  import("./components/EditorTile").then((module) => ({ default: module.EditorTile })),
);
const BoardsPanel = lazy(() =>
  import("./components/BoardsDialog").then((module) => ({ default: module.BoardsPanel })),
);
const FileTreePanel = lazy(() =>
  import("./components/FileTreePanel").then((module) => ({ default: module.FileTreePanel })),
);
const SourceControlPanel = lazy(() =>
  import("./components/SourceControlPanel").then((module) => ({ default: module.SourceControlPanel })),
);
const TeamFeed = lazy(() =>
  import("./components/TeamFeed").then((module) => ({ default: module.TeamFeed })),
);
const AgentGraph = lazy(() =>
  import("./components/AgentGraph").then((module) => ({ default: module.AgentGraph })),
);
const UsagePanel = lazy(() =>
  import("./components/UsagePanel").then((module) => ({ default: module.UsagePanel })),
);

type RightPaneMode = "feed" | "graph" | "usage" | "files" | "scm" | "off";

export default function App() {
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [boardsOpen, setBoardsOpen] = useState(false);
  /// 0..1 — fraction of the main vertical area allocated to the bottom
  /// boards panel. Mid by default; user drags the divider to resize.
  const [boardSplit, setBoardSplit] = useState(0.42);
  const [rightPane, setRightPane] = useState<RightPaneMode>("feed");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [terminalTrayOpen, setTerminalTrayOpen] = useState(false);
  const [workspaceDir, setWorkspaceDir] = useState("");

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const onMove = (m: MouseEvent) => {
      const r = container.getBoundingClientRect();
      // Divider Y as a fraction of container height — the BOTTOM panel
      // size = 1 minus that. Clamp so neither half collapses entirely.
      const topRatio = (m.clientY - r.top) / r.height;
      setBoardSplit(Math.min(0.85, Math.max(0.15, 1 - topRatio)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);
  const [mentionPulse, setMentionPulse] = useState<{ from: string; to: string; key: number } | null>(
    null,
  );

  const upsertAgent = useStore((s) => s.upsertAgent);
  const setStatus = useStore((s) => s.setStatus);
  const appendMessage = useStore((s) => s.appendMessage);
  const appendToolUse = useStore((s) => s.appendToolUse);
  const applyUsage = useStore((s) => s.applyUsage);
  const setHomeDir = useStore((s) => s.setHomeDir);
  const setVendors = useStore((s) => s.setVendors);
  const workspaces = useStore((s) => s.workspaces);
  const setWorkspaces = useStore((s) => s.setWorkspaces);
  const upsertWorkspace = useStore((s) => s.upsertWorkspace);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const removeAgent = useStore((s) => s.removeAgent);
  const upsertPty = useStore((s) => s.upsertPty);
  const removePty = useStore((s) => s.removePty);
  const appendBoardActivity = useStore((s) => s.appendBoardActivity);
  const appendProcessActivity = useStore((s) => s.appendProcessActivity);
  const layout = useStore((s) => s.layout);
  const agents = useStore((s) => s.agents);
  const ptys = useStore((s) => s.ptys);
  const setActive = useStore((s) => s.setActive);
  const removeFromLayout = useStore((s) => s.removeFromLayout);
  const activeTileId = useStore((s) => s.activeTileId);
  const editorVisible = useStore((s) => s.editorVisible);
  const editorTabsCount = useStore((s) =>
    Object.values(s.editorGroups).reduce((acc, g) => acc + g.tabs.length, 0),
  );
  const setEditorVisible = useStore((s) => s.setEditorVisible);

  useEffect(() => {
    api.homeDir().then(setHomeDir).catch(() => {});
    api.workspaceDir()
      .then(async (dir) => {
        const workspace = await api.workspacesBootstrap(dir);
        const list = await api.workspacesList();
        setWorkspaces(list);
        setWorkspaceDir(workspace.root_path);
        setActiveWorkspace(workspaceContextFromWorkspace(workspace));
        const missions = await api.missionsList(workspace.id).catch(() => []);
        useStore.getState().setMissions(missions);
      })
      .catch(() => {});
    api.listVendors().then(setVendors).catch(() => {});
    api.listAgents().then((arr) => arr.forEach(upsertAgent)).catch(() => {});
    // Load persisted theme on first paint.
    api.settingsGetAll()
      .then((s) => applyTheme((s.theme as any) || "cyan"))
      .catch(() => {});
  }, [setHomeDir, setVendors, setWorkspaces, setActiveWorkspace, upsertAgent]);

  const activateWorkspace = useCallback(async (workspace: Workspace) => {
    await api.workspacesTouch(workspace.id).catch(() => {});
    setWorkspaceDir(workspace.root_path);
    setActiveWorkspace(workspaceContextFromWorkspace(workspace));
    const missions = await api.missionsList(workspace.id).catch(() => []);
    useStore.getState().setMissions(missions);
  }, [setActiveWorkspace]);

  const addWorkspace = useCallback(async (rootPath: string) => {
    const workspace = await api.workspacesBootstrap(rootPath);
    const list = await api.workspacesList().catch(() => null);
    if (list) setWorkspaces(list);
    else upsertWorkspace(workspace);
    await activateWorkspace(workspace);
  }, [activateWorkspace, setWorkspaces, upsertWorkspace]);

  const removeWorkspaceFromList = useCallback(async (workspace: Workspace) => {
    await api.workspacesRemove(workspace.id);
    removeWorkspace(workspace.id);
    const list = await api.workspacesList().catch(() => []);
    setWorkspaces(list);
    if (activeWorkspace?.id === workspace.id) {
      const next = list[0] ?? null;
      if (next) {
        await activateWorkspace(next);
      } else {
        setWorkspaceDir("");
        setActiveWorkspace(null);
        useStore.getState().setMissions([]);
      }
    }
  }, [activateWorkspace, activeWorkspace?.id, removeWorkspace, setActiveWorkspace, setWorkspaces]);

  /// Resume a past agent: spawn fresh with --resume <session_id>, then
  /// pre-populate the chat panel with prior messages from the local DB.
  const onResume = async (h: HistoryAgent) => {
    try {
      const snap = await api.resumeAgent(h.spec, h.session_id);
      upsertAgent(snap);
      const past = await api.historyLoadMessages(h.id);
      // Stitch past messages into the new agent's panel so the user sees
      // continuity. The new spawn has a different id; we replay messages
      // under it so the existing ChatPanel just works.
      for (const m of past) {
        appendMessage(snap.id, {
          id: m.id,
          role: m.role as any,
          content: m.content,
          ts: m.ts,
          from_agent_id: m.from_agent_id,
          tool_name: m.tool_name ?? undefined,
          tool_input: m.tool_input,
        });
      }
      await api.historyDeleteAgent(h.id).catch(() => {});
      setActive(snap.id);
    } catch (e) {
      console.error("resume failed", e);
    }
  };

  const openWorkspaceTerminal = useCallback(async () => {
    const cwd = workspaceDir || (await api.workspaceDir());
    const title = nextPtyTitle("Terminal", cwd);
    const snap = await api.spawnPty({
      title,
      cwd,
      workspaceId: activeWorkspace?.id ?? null,
      program: "powershell.exe",
      args: [],
    });
    upsertPty(snap);
    setActive(snap.id);
    setTerminalTrayOpen(true);
  }, [activeWorkspace?.id, setActive, upsertPty, workspaceDir]);

  const openWorkspaceShell = useCallback(async (tool: WorkspaceTool) => {
    const cwd = workspaceDir || (await api.workspaceDir());
    const program =
      tool.binary && tool.binary !== "in-app"
        ? tool.binary
        : tool.id === "wsl"
          ? "wsl.exe"
          : "bash.exe";
    const args =
      tool.id === "wsl"
        ? ["--cd", cwd]
        : tool.id === "git_bash"
          ? ["--login", "-i"]
          : [];
    const snap = await api.spawnPty({
      title: nextPtyTitle(tool.name, cwd),
      cwd,
      workspaceId: activeWorkspace?.id ?? null,
      program,
      args,
    });
    upsertPty(snap);
    setActive(snap.id);
    setTerminalTrayOpen(true);
  }, [activeWorkspace?.id, setActive, upsertPty, workspaceDir]);

  // Use a ref so the unlisten function is captured the moment listen() resolves,
  // even if the effect's cleanup has already run. The `cancelled` flag handles
  // the race where cleanup fires BEFORE the promise resolves.
  const unlistenRef = useRef<UnlistenFn | null>(null);
  // Tracks which agent ids we're already auto-compacting, so a burst of
  // result events doesn't fire compaction multiple times in parallel.
  const autoCompactingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    listen<AgentEvent>("agent://event", (e) => {
      const ev = e.payload;
      switch (ev.kind) {
        case "created":
          upsertAgent(ev.snapshot);
          break;
        case "status":
          setStatus(ev.agent_id, ev.status);
          break;
        case "message":
          appendMessage(ev.agent_id, {
            id: crypto.randomUUID(),
            role: ev.role as any,
            content: ev.content,
            ts: ev.ts,
            from_agent_id: ev.from_agent_id,
          });
          break;
        case "tool_use":
          appendToolUse(ev.agent_id, ev.tool, ev.input, ev.ts);
          break;
        case "result":
          applyUsage(ev.agent_id, ev.usage);
          // Fire-and-forget auto-compact check.
          maybeAutoCompact(ev.agent_id, autoCompactingRef.current);
          break;
        case "mention":
          // to_agent_id is now resolved server-side — no FE store lookup needed.
          if (ev.to_agent_id) {
            setMentionPulse({
              from: ev.from_agent_id,
              to: ev.to_agent_id,
              key: Date.now(),
            });
          }
          break;
        case "mention_blocked":
          // For now just log; could surface a toast later.
          console.warn(
            `[mention blocked] ${ev.from_agent_id} → @${ev.to_agent_name}: ${ev.reason}`,
          );
          break;
        case "board_action":
          appendBoardActivity(
            ev.agent_id,
            ev.action,
            ev.ok,
            ev.message,
            ev.card,
            ev.ts,
          );
          if (ev.ok && ev.card) {
            appendToolUse(ev.agent_id, `board.${ev.action}`, ev.card, ev.ts);
          }
          break;
        case "exit":
          appendProcessActivity(
            ev.agent_id,
            ev.agent_name,
            ev.code,
            ev.stderr_tail,
          );
          // Drop any board-card linkage so the card stops showing
          // "working" once the underlying process is gone.
          useStore.getState().unlinkAgent(ev.agent_id);
          removeAgent(ev.agent_id);
          break;
        case "stderr":
          appendMessage(ev.agent_id, {
            id: crypto.randomUUID(),
            role: "system" as any,
            content: `[stderr] ${ev.line}`,
            ts: new Date().toISOString(),
          });
          break;
      }
    }).then((u) => {
      if (cancelled) {
        // Cleanup already ran — unsubscribe immediately to avoid leak.
        u();
      } else {
        unlistenRef.current = u;
      }
    });
    return () => {
      cancelled = true;
      const u = unlistenRef.current;
      unlistenRef.current = null;
      u?.();
    };
  }, [
    upsertAgent,
    setStatus,
    appendMessage,
    appendToolUse,
    applyUsage,
    removeAgent,
    appendBoardActivity,
    appendProcessActivity,
  ]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    listen<{ pty_id: string; code: number | null }>("pty://exit", (e) => {
      removePty(e.payload.pty_id);
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [removePty]);

  useEffect(() => {
    if (activeTileId && ptys[activeTileId]) {
      setTerminalTrayOpen(true);
    }
    if (Object.keys(ptys).length === 0) {
      setTerminalTrayOpen(false);
    }
  }, [activeTileId, ptys]);

  const inActiveWorkspace = useCallback((cwd: string, workspaceId?: string | null) => {
    if (!activeWorkspace) return true;
    return workspaceId === activeWorkspace.id || isInsideWorkspace(cwd, activeWorkspace.root);
  }, [activeWorkspace]);

  const tiles = layout.filter((id) => {
    const agent = agents[id];
    return agent && inActiveWorkspace(agent.snapshot.spec.cwd, agent.snapshot.spec.workspace_id);
  });
  const terminalIds = Object.keys(ptys).filter((id) =>
    inActiveWorkspace(ptys[id].cwd, (ptys[id] as any).workspace_id),
  );
  const activeTerminalId =
    activeTileId && ptys[activeTileId]
      ? activeTileId
      : terminalIds[terminalIds.length - 1] ?? null;

  return (
    <div className="h-screen w-screen flex bg-base-950 text-base-200 grid-bg">
      <Sidebar
        collapsed={leftCollapsed}
        onToggleCollapsed={() => setLeftCollapsed((v) => !v)}
        onSpawn={() => setSpawnOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenBoards={() => setBoardsOpen((v) => !v)}
        onResume={onResume}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <div className="relative z-[120] h-11 border-b border-base-800 px-3 flex items-center gap-2 bg-base-900/95 backdrop-blur min-w-0">
          {workspaceDir && (
            <WorkspaceToolbar
              cwd={workspaceDir}
              activeWorkspaceId={activeWorkspace?.id ?? null}
              workspaces={workspaces}
              onSelectWorkspace={activateWorkspace}
              onAddWorkspace={addWorkspace}
              onRemoveWorkspace={removeWorkspaceFromList}
              filesActive={rightPane === "files" && !rightCollapsed}
              onTerminal={openWorkspaceTerminal}
              onShell={openWorkspaceShell}
              onToggleFiles={() => {
                setRightPane(rightPane === "files" ? "off" : "files");
                setRightCollapsed(false);
              }}
            />
          )}
          <div className="h-6 w-px bg-base-800 shrink-0" />
          <div className="min-w-0 flex items-center gap-1 text-xs text-base-500 overflow-hidden">
            {leftCollapsed && (
              <ToolbarBtn
                active={false}
                onClick={() => setLeftCollapsed(false)}
                icon={<PanelLeftOpen size={13} />}
                label="Menu"
              />
            )}
            <LayoutGrid size={12} />
            <span className="truncate">{tiles.length} pane{tiles.length === 1 ? "" : "s"}</span>
          </div>
          <div className="ml-auto shrink-0 flex items-center gap-1">
            <ToolbarBtn
              active={editorVisible && editorTabsCount > 0}
              onClick={() => setEditorVisible(!(editorVisible && editorTabsCount > 0))}
              icon={<Code2 size={13} />}
              label={
                editorTabsCount > 0
                  ? `Editor (${editorTabsCount})`
                  : "Editor"
              }
            />
            <ToolbarBtn
              active={rightPane === "feed"}
              onClick={() => setRightPane(rightPane === "feed" ? "off" : "feed")}
              icon={<Eye size={13} />}
              label="Activity"
            />
            <ToolbarBtn
              active={rightPane === "graph"}
              onClick={() => setRightPane(rightPane === "graph" ? "off" : "graph")}
              icon={<Network size={13} />}
              label="Graph"
            />
            <ToolbarBtn
              active={rightPane === "usage"}
              onClick={() => setRightPane(rightPane === "usage" ? "off" : "usage")}
              icon={<Zap size={13} />}
              label="Usage"
            />
            <ToolbarBtn
              active={rightPane === "scm"}
              onClick={() => setRightPane(rightPane === "scm" ? "off" : "scm")}
              icon={<GitBranch size={13} />}
              label="Source Control"
            />
            <ToolbarBtn
              active={rightPane === "files"}
              onClick={() => setRightPane(rightPane === "files" ? "off" : "files")}
              icon={<Files size={13} />}
              label="Files"
            />
            {rightPane !== "off" && (
              <ToolbarIconBtn
                onClick={() => setRightCollapsed((v) => !v)}
                icon={rightCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
                label={rightCollapsed ? "Expand right sidebar" : "Collapse right sidebar"}
              />
            )}
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Vertical split: agents (top) / boards (bottom) */}
          <div ref={splitContainerRef} className="flex-1 min-w-0 flex flex-col">
            <div className="flex-1 min-h-0 flex flex-col">
              <div
                className="min-h-0 p-3 overflow-auto"
                style={{
                  flex: boardsOpen ? `0 0 ${(1 - boardSplit) * 100}%` : "1 1 100%",
                }}
              >
                {tiles.length === 0 && !(editorVisible && editorTabsCount > 0) ? (
                  <EmptyState onSpawn={() => setSpawnOpen(true)} />
                ) : (
                  <div
                    className="grid gap-3 h-full"
                    style={{
                      gridTemplateColumns: `repeat(${gridCols(
                        tiles.length + (editorVisible && editorTabsCount > 0 ? 1 : 0),
                      )}, minmax(0, 1fr))`,
                      gridAutoRows: "minmax(0, 1fr)",
                    }}
                  >
                    {tiles.map((id) => (
                      <div
                        key={id}
                        className="min-h-0 min-w-0"
                        onClick={() => setActive(id)}
                      >
                        <ChatPanel agentId={id} onClose={() => removeFromLayout(id)} />
                      </div>
                    ))}
                    {editorVisible && editorTabsCount > 0 && (
                      <div key="__editor__" className="min-h-0 min-w-0 relative">
                        <Suspense fallback={<EditorLoading />}>
                          <EditorTile onClose={() => setEditorVisible(false)} />
                        </Suspense>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {boardsOpen && (
                <>
                  {/* Drag handle to resize the split */}
                  <div
                    onMouseDown={startResize}
                    className="h-1 shrink-0 cursor-row-resize bg-base-800 hover:bg-(--color-accent-cyan)/60 transition relative group"
                    title="Drag to resize"
                  >
                    <div className="absolute inset-x-0 -top-0.5 h-2" />
                  </div>
                  <div
                    className="min-h-0"
                    style={{ flex: `0 0 ${boardSplit * 100}%` }}
                  >
                    <Suspense fallback={<PanelLoading />}>
                      <BoardsPanel onClose={() => setBoardsOpen(false)} />
                    </Suspense>
                  </div>
                </>
              )}
            </div>

            {terminalTrayOpen && terminalIds.length > 0 && activeTerminalId && (
              <TerminalTray
                ids={terminalIds}
                activeId={activeTerminalId}
                onActive={setActive}
                onNew={openWorkspaceTerminal}
                onCloseTray={() => setTerminalTrayOpen(false)}
                onKill={async (id) => {
                  await api.killPty(id).catch(() => {});
                  removePty(id);
                }}
              />
            )}
          </div>

          {rightPane !== "off" && rightCollapsed && (
            <RightRail
              mode={rightPane}
              onMode={(mode) => {
                setRightPane(mode);
                setRightCollapsed(false);
              }}
              onExpand={() => setRightCollapsed(false)}
            />
          )}

          {rightPane !== "off" && !rightCollapsed && (
            <div className="w-96 shrink-0 border-l border-base-800 p-3 bg-base-950/40">
              <Suspense fallback={<PanelLoading />}>
                {rightPane === "feed" && <TeamFeed />}
                {rightPane === "graph" && <AgentGraph mentionPulse={mentionPulse} />}
                {rightPane === "usage" && <UsagePanel />}
                {rightPane === "files" && (
                  <FileTreePanel root={workspaceDir} onClose={() => setRightPane("off")} />
                )}
                {rightPane === "scm" && (
                  <SourceControlPanel cwd={workspaceDir} onClose={() => setRightPane("off")} />
                )}
              </Suspense>
            </div>
          )}
        </div>
      </main>

      <SpawnDialog open={spawnOpen} onClose={() => setSpawnOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function ToolbarBtn({
  active, onClick, icon, label,
}: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "px-2 py-1 text-xs rounded-md flex items-center gap-1 transition border",
        active
          ? "bg-(--color-accent-cyan)/15 text-(--color-accent-cyan) border-(--color-accent-cyan)/30"
          : "text-base-400 hover:text-base-200 border-transparent hover:bg-base-800/50",
      )}
    >
      {icon} <span className="hidden 2xl:inline">{label}</span>
    </button>
  );
}

function ToolbarIconBtn({
  onClick,
  icon,
  label,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className="h-7 w-7 rounded-md border border-transparent text-base-400 hover:text-base-200 hover:bg-base-800/50 flex items-center justify-center transition"
      title={label}
      aria-label={label}
    >
      {icon}
    </button>
  );
}

function TerminalTray({
  ids,
  activeId,
  onActive,
  onNew,
  onCloseTray,
  onKill,
}: {
  ids: string[];
  activeId: string;
  onActive: (id: string) => void;
  onNew: () => void;
  onCloseTray: () => void;
  onKill: (id: string) => void;
}) {
  const ptys = useStore((s) => s.ptys);
  const active = ptys[activeId] ? activeId : ids[0];

  return (
    <div className="h-[34vh] min-h-52 shrink-0 border-t border-base-800 bg-base-950/95 flex flex-col">
      <div className="h-9 shrink-0 px-3 border-b border-base-800 bg-base-900/80 flex items-center gap-2">
        <div className="flex items-center gap-4 text-[11px] tracking-wide text-base-500 uppercase">
          <span className="text-base-300 border-b border-(--color-accent-cyan) py-2">
            Terminal
          </span>
        </div>
        <div className="h-5 w-px bg-base-800" />
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto">
          {ids.map((id) => {
            const p = ptys[id];
            if (!p) return null;
            return (
              <button
                key={id}
                onClick={() => onActive(id)}
                className={cn(
                  "group h-7 max-w-44 px-2 rounded-md flex items-center gap-2 text-xs border transition shrink-0",
                  active === id
                    ? "bg-base-800 text-base-100 border-base-700"
                    : "text-base-500 border-transparent hover:text-base-200 hover:bg-base-800/60",
                )}
                title={p.cwd}
              >
                <span className="truncate">{p.title}</span>
                <span className="hidden xl:inline text-[10px] text-base-500 truncate max-w-24">
                  {workspaceNameFromPath(p.cwd)}
                </span>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onKill(id);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-base-500 hover:text-(--color-accent-red)"
                  title="Kill terminal"
                >
                  <X size={12} />
                </span>
              </button>
            );
          })}
        </div>
        <button
          onClick={onNew}
          className="h-7 w-7 rounded-md text-base-500 hover:text-base-100 hover:bg-base-800 flex items-center justify-center"
          title="New terminal"
        >
          <Plus size={15} />
        </button>
        <button
          onClick={onCloseTray}
          className="h-7 w-7 rounded-md text-base-500 hover:text-base-100 hover:bg-base-800 flex items-center justify-center"
          title="Hide terminal panel"
        >
          <PanelBottomClose size={15} />
        </button>
      </div>
      <div className="flex-1 min-h-0 p-2 flex flex-col">
        {ptys[active] && (
          <div className="mb-1 px-1 text-[10px] text-base-500 font-mono truncate">
            Workspace: {workspaceNameFromPath(ptys[active].cwd)} · {shortPath(ptys[active].cwd)}
          </div>
        )}
        <div className="flex-1 min-h-0">
          <TerminalPanel ptyId={active} chrome={false} />
        </div>
      </div>
    </div>
  );
}

function RightRail({
  mode,
  onMode,
  onExpand,
}: {
  mode: Exclude<RightPaneMode, "off">;
  onMode: (mode: Exclude<RightPaneMode, "off">) => void;
  onExpand: () => void;
}) {
  return (
    <div className="w-12 shrink-0 border-l border-base-800 bg-base-950/60 flex flex-col items-center py-3 gap-2">
      <RailButton
        active={false}
        onClick={onExpand}
        icon={<PanelRightOpen size={16} />}
        label="Expand right sidebar"
      />
      <div className="h-px w-7 bg-base-800 my-1" />
      <RailButton
        active={mode === "feed"}
        onClick={() => onMode("feed")}
        icon={<Eye size={15} />}
        label="Activity"
      />
      <RailButton
        active={mode === "graph"}
        onClick={() => onMode("graph")}
        icon={<Network size={15} />}
        label="Graph"
      />
      <RailButton
        active={mode === "usage"}
        onClick={() => onMode("usage")}
        icon={<Zap size={15} />}
        label="Usage"
      />
      <RailButton
        active={mode === "scm"}
        onClick={() => onMode("scm")}
        icon={<GitBranch size={15} />}
        label="Source Control"
      />
      <RailButton
        active={mode === "files"}
        onClick={() => onMode("files")}
        icon={<Files size={15} />}
        label="Files"
      />
    </div>
  );
}

function RailButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "h-8 w-8 rounded-md border flex items-center justify-center transition",
        active
          ? "bg-(--color-accent-cyan)/15 text-(--color-accent-cyan) border-(--color-accent-cyan)/35"
          : "text-base-500 border-transparent hover:text-base-200 hover:bg-base-800/60",
      )}
    >
      {icon}
    </button>
  );
}

function EmptyState({ onSpawn }: { onSpawn: () => void }) {
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const body = activeWorkspace ? (
    <>
      Active workspace:{" "}
      <span className="text-(--color-accent-cyan) font-mono">
        {activeWorkspace.name}
      </span>
      . Spawn agents here, then assign cards or message them with workspace
      context attached automatically.
    </>
  ) : (
    <>
      Spawn multiple Claude agents that can work in parallel and talk to each
      other using <span className="text-(--color-accent-cyan)">@AgentName</span>.
      Watch them collaborate in the Activity feed and Graph view.
    </>
  );
  return (
    <div className="h-full flex flex-col items-center justify-center text-center">
      <div className="text-6xl mb-4 select-none">⌬</div>
      <div className="text-lg font-semibold mb-1">Multi-Agent Control Center</div>
      <div className="text-sm text-base-500 mb-6 max-w-md">{body}</div>
      <button
        onClick={onSpawn}
        className="px-4 py-2 rounded-md bg-(--color-accent-cyan)/20 hover:bg-(--color-accent-cyan)/30 border border-(--color-accent-cyan)/40 text-(--color-accent-cyan) text-sm transition"
      >
        + Spawn your first agent
      </button>
    </div>
  );
}

function EditorLoading() {
  return (
    <div className="h-full w-full rounded-lg border border-(--color-accent-amber)/25 bg-base-950 flex items-center justify-center text-xs text-base-500">
      Loading editor...
    </div>
  );
}

function PanelLoading() {
  return (
    <div className="h-full min-h-32 rounded-md border border-base-800 bg-base-950/60 flex items-center justify-center text-xs text-base-500">
      Loading...
    </div>
  );
}

function gridCols(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

function nextPtyTitle(base: string, cwd: string): string {
  const used = new Set(
    Object.values(useStore.getState().ptys)
      .filter((p) => p.cwd === cwd)
      .map((p) => p.title),
  );
  let i = 1;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

/// Fire-and-forget: when a result event arrives, peek at the agent's current
/// context size and, if auto-compact is on AND we've crossed the threshold,
/// kick off compaction. Guarded against concurrent runs per agent id.
async function maybeAutoCompact(agentId: string, inflight: Set<string>) {
  if (inflight.has(agentId)) return;
  // Read settings — small enough to fetch each time; cached well by Tauri IPC.
  let on = false;
  let threshold = 85;
  try {
    const s = await api.settingsGetAll();
    on = s.auto_compact === "true";
    threshold = Number(s.auto_compact_threshold ?? "85") || 85;
  } catch {
    return;
  }
  if (!on) return;

  const record = useStore.getState().agents[agentId];
  if (!record) return;
  const ctx = record.snapshot.current_context_tokens;
  const pct = (ctx / DEFAULT_CONTEXT_WINDOW) * 100;
  if (pct < threshold) return;

  inflight.add(agentId);
  try {
    await compactAgent(agentId);
  } catch (e) {
    console.warn("auto-compact failed:", e);
  } finally {
    inflight.delete(agentId);
  }
}
