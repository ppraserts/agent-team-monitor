import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Code2,
  Folder,
  GitBranch,
  PanelRight,
  SquareTerminal,
} from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import type { GitStatus, WorkspaceTool } from "../types";

interface Props {
  cwd: string;
  filesActive: boolean;
  onTerminal: () => void;
  onShell: (tool: WorkspaceTool) => void;
  onToggleFiles: () => void;
}

export function WorkspaceToolbar({
  cwd,
  filesActive,
  onTerminal,
  onShell,
  onToggleFiles,
}: Props) {
  const [tools, setTools] = useState<WorkspaceTool[]>([]);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [toolOpen, setToolOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);

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
