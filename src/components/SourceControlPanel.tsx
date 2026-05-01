import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudDownload,
  CloudUpload,
  Code2,
  GitBranch as GitBranchIcon,
  GitCommitHorizontal,
  History,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { openFileInEditor } from "../lib/editor";
import type {
  GitBranch,
  GitChanges,
  GitCommit,
  GitFileChange,
  GitStash,
} from "../types";
import { GitDiffDialog } from "./GitDiffDialog";

interface Props {
  cwd: string;
  onClose: () => void;
}

type Section = "staged" | "changes" | "untracked" | "conflicts";

export function SourceControlPanel({ cwd, onClose }: Props) {
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [openDiff, setOpenDiff] = useState<{
    file: GitFileChange;
    staged: boolean;
  } | null>(null);
  const [open, setOpen] = useState<Record<Section, boolean>>({
    staged: true,
    changes: true,
    untracked: true,
    conflicts: true,
  });
  const [branchOpen, setBranchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [stashesOpen, setStashesOpen] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const c = await api.gitChanges(cwd);
      setChanges(c);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [cwd]);

  useEffect(() => {
    refresh();
    pollRef.current = window.setInterval(refresh, 5000);
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  const groups = useMemo(() => {
    const files = changes?.files ?? [];
    return {
      staged: files.filter((f) => f.staged && !f.is_conflicted),
      changes: files.filter(
        (f) => f.unstaged && !f.is_untracked && !f.is_conflicted,
      ),
      untracked: files.filter((f) => f.is_untracked),
      conflicts: files.filter((f) => f.is_conflicted),
    };
  }, [changes]);

  const wrap = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(label);
    setError(null);
    try {
      const r = await fn();
      await refresh();
      return r;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const onCommit = async () => {
    if (!message.trim() && !amend) {
      setError("Commit message is required");
      return;
    }
    const ok = await wrap("commit", () =>
      api.gitCommit(cwd, { message: message.trim(), amend }),
    );
    if (ok !== null) {
      setMessage("");
      setAmend(false);
    }
  };

  const onSync = async () => {
    if (!changes?.has_remote) return;
    if (!changes.upstream) {
      await wrap("sync", () => api.gitPush(cwd, true));
      return;
    }
    await wrap("sync", async () => {
      await api.gitPull(cwd);
      if (changes.ahead > 0) {
        await api.gitPush(cwd, false);
      }
    });
  };

  const fileRow = (
    file: GitFileChange,
    staged: boolean,
    section: Section,
  ) => {
    const code = staged ? file.xy.charAt(0) : file.xy.charAt(1);
    const badge = badgeFor(file, code);
    return (
      <div
        key={`${section}-${file.path}-${staged ? "s" : "w"}`}
        className="group flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-base-800/60 text-xs"
      >
        <button
          onClick={() => setOpenDiff({ file, staged })}
          className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
          title={`${file.path}${file.old_path ? ` (from ${file.old_path})` : ""} — click to view diff`}
        >
          <span
            className={cn(
              "shrink-0 w-4 text-center font-mono text-[10px] rounded border",
              badge.className,
            )}
          >
            {badge.label}
          </span>
          <span className="truncate font-mono">{shortName(file.path)}</span>
          <span className="truncate text-[10px] text-base-600">
            {dirOf(file.path)}
          </span>
        </button>
        <div className="shrink-0 flex items-center opacity-0 group-hover:opacity-100 transition">
          <button
            onClick={() =>
              openFileInEditor(file.path).catch((err) => setError(String(err)))
            }
            className="h-6 w-6 rounded text-base-500 hover:text-(--color-accent-amber) hover:bg-base-800 flex items-center justify-center"
            title="Open in editor"
          >
            <Code2 size={12} />
          </button>
          {!file.is_untracked && (
            <button
              onClick={() =>
                wrap(
                  "discard",
                  () => api.gitDiscard(cwd, [file.path], false),
                )
              }
              className="h-6 w-6 rounded text-base-500 hover:text-(--color-accent-red) hover:bg-base-800 flex items-center justify-center"
              title="Discard changes"
            >
              <Undo2 size={12} />
            </button>
          )}
          {file.is_untracked && (
            <button
              onClick={() =>
                wrap("clean", () => api.gitDiscard(cwd, [file.path], true))
              }
              className="h-6 w-6 rounded text-base-500 hover:text-(--color-accent-red) hover:bg-base-800 flex items-center justify-center"
              title="Delete untracked file"
            >
              <Trash2 size={12} />
            </button>
          )}
          {staged ? (
            <button
              onClick={() =>
                wrap("unstage", () => api.gitUnstage(cwd, [file.path]))
              }
              className="h-6 w-6 rounded text-base-500 hover:text-(--color-accent-cyan) hover:bg-base-800 flex items-center justify-center"
              title="Unstage"
            >
              <ArrowDownToLine size={12} />
            </button>
          ) : (
            <button
              onClick={() =>
                wrap("stage", () => api.gitStage(cwd, [file.path]))
              }
              className="h-6 w-6 rounded text-base-500 hover:text-(--color-accent-green) hover:bg-base-800 flex items-center justify-center"
              title="Stage"
            >
              <ArrowUpFromLine size={12} />
            </button>
          )}
        </div>
      </div>
    );
  };

  const sectionHeader = (
    key: Section,
    title: string,
    files: GitFileChange[],
    actions?: React.ReactNode,
  ) => {
    if (files.length === 0) return null;
    const isOpen = open[key];
    return (
      <div className="mb-1">
        <div className="flex items-center gap-1 px-1 py-0.5">
          <button
            onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-base-400 hover:text-base-200"
          >
            {isOpen ? (
              <ChevronDown size={11} />
            ) : (
              <ChevronRight size={11} />
            )}
            {title}
            <span className="text-base-600">({files.length})</span>
          </button>
          <div className="ml-auto flex items-center">{actions}</div>
        </div>
        {isOpen && (
          <div className="space-y-0.5">
            {files.map((f) =>
              fileRow(f, key === "staged", key),
            )}
          </div>
        )}
      </div>
    );
  };

  const totalChanged = changes?.files.length ?? 0;
  const stagedCount = groups.staged.length;
  const isRepo = changes?.is_repo ?? false;

  return (
    <div className="h-full min-h-0 rounded-md border border-base-800 bg-base-900/70 flex flex-col overflow-hidden">
      <div className="h-10 px-3 border-b border-base-800 flex items-center gap-2">
        <GitBranchIcon size={15} className="text-(--color-accent-violet)" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">Source Control</div>
          <div className="text-[10px] text-base-500 truncate" title={cwd}>
            {cwd}
          </div>
        </div>
        <button
          onClick={refresh}
          className="h-7 w-7 rounded-md text-base-500 hover:text-base-200 hover:bg-base-800 flex items-center justify-center"
          title="Refresh"
        >
          {busy === "refresh" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RotateCw size={13} />
          )}
        </button>
        <button
          onClick={onClose}
          className="h-7 w-7 rounded-md text-base-500 hover:text-base-200 hover:bg-base-800 flex items-center justify-center"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      {!isRepo ? (
        <div className="flex-1 flex items-center justify-center p-6 text-center text-xs text-base-500">
          This workspace is not a git repository.
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Branch + sync row */}
          <div className="px-2 pt-2 flex items-center gap-1 relative">
            <button
              onClick={() => setBranchOpen((v) => !v)}
              className="flex-1 min-w-0 px-2 py-1 rounded-md border border-base-700 hover:border-(--color-accent-violet)/40 hover:bg-base-800/60 transition flex items-center gap-1.5 text-xs"
              title="Switch branch"
            >
              <GitBranchIcon size={12} className="text-(--color-accent-violet) shrink-0" />
              <span className="truncate">{changes?.branch ?? "(detached)"}</span>
              {changes?.upstream && (
                <span className="text-[10px] text-base-500 truncate">
                  → {changes.upstream}
                </span>
              )}
              <ChevronDown size={11} className="ml-auto text-base-500" />
            </button>
            {changes?.has_remote && (
              <>
                <button
                  onClick={onSync}
                  disabled={!!busy}
                  className="px-2 py-1 rounded-md border border-base-700 hover:border-(--color-accent-cyan)/40 hover:bg-base-800/60 transition flex items-center gap-1 text-[11px] disabled:opacity-50"
                  title={
                    !changes.upstream
                      ? "Publish branch (push -u origin)"
                      : `Sync (pull, then push)${
                          changes.ahead || changes.behind
                            ? ` — ↑${changes.ahead} ↓${changes.behind}`
                            : ""
                        }`
                  }
                >
                  {busy === "sync" ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : !changes.upstream ? (
                    <Cloud size={11} className="text-(--color-accent-cyan)" />
                  ) : (
                    <>
                      <CloudDownload size={11} className="text-(--color-accent-cyan)" />
                      <CloudUpload size={11} className="text-(--color-accent-cyan)" />
                    </>
                  )}
                  {(changes.ahead > 0 || changes.behind > 0) && (
                    <span className="text-[10px] font-mono text-base-400">
                      ↑{changes.ahead} ↓{changes.behind}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => wrap("fetch", () => api.gitFetch(cwd))}
                  disabled={!!busy}
                  className="h-7 w-7 rounded-md border border-base-700 hover:border-(--color-accent-cyan)/40 hover:bg-base-800/60 transition flex items-center justify-center disabled:opacity-50"
                  title="Fetch"
                >
                  {busy === "fetch" ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <CloudDownload size={11} className="text-base-400" />
                  )}
                </button>
              </>
            )}
            {branchOpen && (
              <BranchSwitcher
                cwd={cwd}
                current={changes?.branch ?? null}
                onClose={() => setBranchOpen(false)}
                onAfter={refresh}
              />
            )}
          </div>

          {/* Commit input */}
          <div className="px-2 pt-2">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  onCommit();
                }
              }}
              placeholder={`Message (Ctrl+Enter to commit on '${changes?.branch ?? "HEAD"}')`}
              rows={2}
              className="w-full resize-none rounded-md bg-base-950 border border-base-700 px-2 py-1.5 text-xs font-mono outline-none focus:border-(--color-accent-violet)/50"
            />
            <div className="mt-1 flex items-center gap-1.5">
              <button
                onClick={onCommit}
                disabled={
                  !!busy || (stagedCount === 0 && !amend)
                }
                className={cn(
                  "flex-1 px-2 py-1.5 rounded-md text-xs font-medium flex items-center justify-center gap-1.5 transition border",
                  stagedCount > 0 || amend
                    ? "bg-(--color-accent-violet)/20 hover:bg-(--color-accent-violet)/30 border-(--color-accent-violet)/40 text-(--color-accent-violet)"
                    : "bg-base-800/40 border-base-700 text-base-500 cursor-not-allowed",
                )}
                title={
                  stagedCount === 0 && !amend
                    ? "Stage at least one file first, or enable Amend"
                    : amend
                    ? "Amend the previous commit"
                    : `Commit ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}`
                }
              >
                {busy === "commit" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Check size={12} />
                )}
                {amend ? "Commit (Amend)" : "Commit"}
                {stagedCount > 0 && !amend && (
                  <span className="text-[10px] opacity-70">· {stagedCount}</span>
                )}
              </button>
              <button
                onClick={() => setAmend((v) => !v)}
                className={cn(
                  "h-7 px-2 rounded-md text-[10px] uppercase tracking-wider border transition",
                  amend
                    ? "border-(--color-accent-amber)/50 text-(--color-accent-amber) bg-(--color-accent-amber)/10"
                    : "border-base-700 text-base-500 hover:border-base-600",
                )}
                title="Amend the previous commit instead of creating a new one"
              >
                Amend
              </button>
            </div>
            {error && (
              <div className="mt-1 text-[11px] text-(--color-accent-red) font-mono whitespace-pre-wrap break-words">
                {error}
              </div>
            )}
          </div>

          {/* File sections */}
          <div className="flex-1 min-h-0 overflow-auto px-2 pt-2 pb-3">
            {totalChanged === 0 && (
              <div className="text-center text-xs text-base-500 py-6">
                Working tree clean.
              </div>
            )}
            {sectionHeader(
              "conflicts",
              "Conflicts",
              groups.conflicts,
            )}
            {sectionHeader(
              "staged",
              "Staged Changes",
              groups.staged,
              groups.staged.length > 0 && (
                <button
                  onClick={() =>
                    wrap("unstageAll", () => api.gitUnstageAll(cwd))
                  }
                  className="h-5 w-5 rounded text-base-500 hover:text-(--color-accent-cyan) hover:bg-base-800 flex items-center justify-center"
                  title="Unstage all"
                >
                  <ArrowDownToLine size={10} />
                </button>
              ),
            )}
            {sectionHeader(
              "changes",
              "Changes",
              groups.changes,
              groups.changes.length > 0 && (
                <button
                  onClick={() =>
                    wrap("stageAll", () => api.gitStageAll(cwd))
                  }
                  className="h-5 w-5 rounded text-base-500 hover:text-(--color-accent-green) hover:bg-base-800 flex items-center justify-center"
                  title="Stage all"
                >
                  <Plus size={10} />
                </button>
              ),
            )}
            {sectionHeader(
              "untracked",
              "Untracked",
              groups.untracked,
              groups.untracked.length > 0 && (
                <button
                  onClick={() =>
                    wrap("stageAll", () => api.gitStageAll(cwd))
                  }
                  className="h-5 w-5 rounded text-base-500 hover:text-(--color-accent-green) hover:bg-base-800 flex items-center justify-center"
                  title="Stage all"
                >
                  <Plus size={10} />
                </button>
              ),
            )}
          </div>

          {/* Stashes / History collapsible footers */}
          <CollapsibleSection
            icon={<MoreHorizontal size={11} />}
            title="Stashes"
            open={stashesOpen}
            onToggle={() => setStashesOpen((v) => !v)}
          >
            <StashList cwd={cwd} onAfter={refresh} hasChanges={totalChanged > 0} />
          </CollapsibleSection>
          <CollapsibleSection
            icon={<History size={11} />}
            title="History"
            open={historyOpen}
            onToggle={() => setHistoryOpen((v) => !v)}
          >
            <CommitHistory cwd={cwd} />
          </CollapsibleSection>
        </div>
      )}

      {openDiff && (
        <GitDiffDialog
          cwd={cwd}
          file={openDiff.file}
          staged={openDiff.staged}
          onClose={() => setOpenDiff(null)}
          onAfterAction={refresh}
        />
      )}
    </div>
  );
}

function CollapsibleSection({
  icon,
  title,
  open,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-base-800">
      <button
        onClick={onToggle}
        className="w-full px-3 py-1.5 text-[11px] uppercase tracking-wider text-base-400 hover:text-base-200 flex items-center gap-1.5"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {icon}
        {title}
      </button>
      {open && <div className="px-2 pb-2 max-h-48 overflow-auto">{children}</div>}
    </div>
  );
}

function CommitHistory({ cwd }: { cwd: string }) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .gitLog(cwd, 30)
      .then(setCommits)
      .catch((e) => setError(String(e)));
  }, [cwd]);
  if (error) {
    return (
      <div className="text-[11px] text-(--color-accent-red) px-1">{error}</div>
    );
  }
  if (!commits) {
    return <div className="text-[11px] text-base-500 px-1">Loading…</div>;
  }
  if (commits.length === 0) {
    return <div className="text-[11px] text-base-500 px-1">No commits yet.</div>;
  }
  return (
    <div className="space-y-1">
      {commits.map((c) => (
        <div
          key={c.hash}
          className="flex items-start gap-2 px-1 py-0.5 rounded hover:bg-base-800/50 text-[11px]"
          title={`${c.author} <${c.email}>\n${c.date}\n${c.hash}`}
        >
          <GitCommitHorizontal size={11} className="text-base-500 mt-0.5 shrink-0" />
          <span className="font-mono text-(--color-accent-violet) shrink-0">
            {c.short_hash}
          </span>
          <span className="truncate text-base-300">{c.subject}</span>
        </div>
      ))}
    </div>
  );
}

function StashList({
  cwd,
  onAfter,
  hasChanges,
}: {
  cwd: string;
  onAfter: () => void;
  hasChanges: boolean;
}) {
  const [stashes, setStashes] = useState<GitStash[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const reload = useCallback(() => {
    api
      .gitStashList(cwd)
      .then(setStashes)
      .catch((e) => setError(String(e)));
  }, [cwd]);
  useEffect(() => {
    reload();
  }, [reload]);
  const wrap = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
      onAfter();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      {hasChanges && (
        <div className="flex gap-1">
          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder="Stash message (optional)"
            className="flex-1 bg-base-950 border border-base-700 rounded px-2 py-1 text-[11px] outline-none focus:border-(--color-accent-cyan)/50"
          />
          <button
            disabled={busy}
            onClick={() =>
              wrap(async () => {
                await api.gitStashSave(cwd, msg, true);
                setMsg("");
              })
            }
            className="px-2 rounded border border-base-700 hover:border-(--color-accent-cyan)/40 text-[11px] disabled:opacity-50"
            title="Stash all changes including untracked"
          >
            Stash
          </button>
        </div>
      )}
      {error && <div className="text-[11px] text-(--color-accent-red) px-1">{error}</div>}
      {stashes && stashes.length === 0 && (
        <div className="text-[11px] text-base-500 px-1">No stashes.</div>
      )}
      {stashes?.map((s) => (
        <div
          key={s.index}
          className="group flex items-center gap-1 px-1 py-1 rounded hover:bg-base-800/50 text-[11px]"
        >
          <span className="font-mono text-(--color-accent-violet) shrink-0">
            {s.name}
          </span>
          <span className="truncate flex-1 text-base-300">{s.message}</span>
          <div className="opacity-0 group-hover:opacity-100 flex">
            <button
              disabled={busy}
              onClick={() => wrap(() => api.gitStashPop(cwd, s.index))}
              className="h-5 w-5 rounded text-base-500 hover:text-(--color-accent-green) hover:bg-base-800 flex items-center justify-center"
              title="Pop"
            >
              <ArrowDownToLine size={10} />
            </button>
            <button
              disabled={busy}
              onClick={() => wrap(() => api.gitStashDrop(cwd, s.index))}
              className="h-5 w-5 rounded text-base-500 hover:text-(--color-accent-red) hover:bg-base-800 flex items-center justify-center"
              title="Drop"
            >
              <Trash2 size={10} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function BranchSwitcher({
  cwd,
  current,
  onClose,
  onAfter,
}: {
  cwd: string;
  current: string | null;
  onClose: () => void;
  onAfter: () => void;
}) {
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .gitBranches(cwd)
      .then(setBranches)
      .catch((e) => setError(String(e)));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = branches ?? [];
    return q ? list.filter((b) => b.name.toLowerCase().includes(q)) : list;
  }, [branches, filter]);

  const create = filter.trim();
  const showCreate =
    !!create &&
    branches &&
    !branches.some((b) => b.name === create);

  const onPick = async (name: string, createNew: boolean) => {
    setBusy(true);
    setError(null);
    try {
      // For remote refs like "origin/feat-x", strip the remote and create a tracking branch.
      let target = name;
      if (!createNew && name.includes("/") && branches?.find((b) => b.name === name)?.is_remote) {
        target = name.split("/").slice(1).join("/");
        await api.gitCheckout(cwd, target, true);
      } else {
        await api.gitCheckout(cwd, target, createNew);
      }
      onAfter();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[150]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="absolute right-2 top-12 w-80 max-h-96 rounded-md border border-base-700 bg-base-950 shadow-2xl flex flex-col overflow-hidden">
        <div className="px-2 py-1.5 border-b border-base-800 text-[10px] uppercase tracking-wider text-base-400 flex items-center justify-between">
          <span>Switch branch</span>
          <span className="text-base-600">on {current ?? "(none)"}</span>
        </div>
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter or type new branch name…"
          className="m-2 px-2 py-1 text-xs bg-base-900 border border-base-700 rounded outline-none focus:border-(--color-accent-violet)/50"
        />
        <div className="flex-1 min-h-0 overflow-auto px-1 pb-2">
          {error && (
            <div className="px-2 py-1 text-[11px] text-(--color-accent-red)">
              {error}
            </div>
          )}
          {showCreate && (
            <button
              disabled={busy}
              onClick={() => onPick(create, true)}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-base-800/60 text-xs flex items-center gap-1.5 disabled:opacity-50"
            >
              <Plus size={11} className="text-(--color-accent-green)" />
              Create branch{" "}
              <span className="font-mono text-(--color-accent-green)">{create}</span>
            </button>
          )}
          {filtered.map((b) => (
            <button
              key={`${b.is_remote ? "r" : "l"}:${b.name}`}
              disabled={busy || b.is_current}
              onClick={() => onPick(b.name, false)}
              className={cn(
                "w-full text-left px-2 py-1 rounded text-xs flex items-center gap-1.5 disabled:opacity-50",
                b.is_current ? "bg-base-800/40" : "hover:bg-base-800/60",
              )}
              title={b.upstream ? `tracks ${b.upstream}` : undefined}
            >
              {b.is_current ? (
                <Check size={11} className="text-(--color-accent-violet)" />
              ) : b.is_remote ? (
                <Cloud size={11} className="text-base-500" />
              ) : (
                <GitBranchIcon size={11} className="text-base-500" />
              )}
              <span className="truncate font-mono">{b.name}</span>
              {b.upstream && !b.is_remote && (
                <span className="ml-auto text-[10px] text-base-600 truncate">
                  → {b.upstream}
                </span>
              )}
            </button>
          ))}
          {branches && filtered.length === 0 && !showCreate && (
            <div className="px-2 py-1 text-[11px] text-base-500">No matches.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function shortName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1];
}

function dirOf(p: string): string {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join("/");
}

function badgeFor(
  file: GitFileChange,
  code: string,
): { label: string; className: string } {
  if (file.is_conflicted) {
    return {
      label: "!",
      className:
        "border-(--color-accent-red)/50 text-(--color-accent-red) bg-(--color-accent-red)/10",
    };
  }
  if (file.is_untracked) {
    return {
      label: "U",
      className:
        "border-(--color-accent-green)/50 text-(--color-accent-green) bg-(--color-accent-green)/10",
    };
  }
  switch (code) {
    case "M":
      return {
        label: "M",
        className:
          "border-(--color-accent-amber)/50 text-(--color-accent-amber) bg-(--color-accent-amber)/10",
      };
    case "A":
      return {
        label: "A",
        className:
          "border-(--color-accent-green)/50 text-(--color-accent-green) bg-(--color-accent-green)/10",
      };
    case "D":
      return {
        label: "D",
        className:
          "border-(--color-accent-red)/50 text-(--color-accent-red) bg-(--color-accent-red)/10",
      };
    case "R":
      return {
        label: "R",
        className:
          "border-(--color-accent-cyan)/50 text-(--color-accent-cyan) bg-(--color-accent-cyan)/10",
      };
    default:
      return {
        label: code || "?",
        className: "border-base-600 text-base-400 bg-base-800",
      };
  }
}
