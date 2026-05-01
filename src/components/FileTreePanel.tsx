import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { openFileInEditor } from "../lib/editor";
import { useStore } from "../store";
import type { FsEntry } from "../types";

interface Props {
  root: string;
  onClose: () => void;
}

type PendingCreate = {
  parentPath: string;
  kind: "file" | "folder";
};

interface TreeContext {
  refreshAll: () => void;
  pendingCreate: PendingCreate | null;
  startCreate: (parentPath: string, kind: "file" | "folder") => void;
  finishCreate: () => void;
  renamingPath: string | null;
  startRename: (path: string) => void;
  finishRename: () => void;
}

export function FileTreePanel({ root, onClose }: Props) {
  const [revision, setRevision] = useState(0);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ctx: TreeContext = {
    refreshAll: () => setRevision((v) => v + 1),
    pendingCreate,
    startCreate: (parentPath, kind) => {
      setPendingCreate({ parentPath, kind });
      setRenamingPath(null);
    },
    finishCreate: () => setPendingCreate(null),
    renamingPath,
    startRename: (path) => {
      setRenamingPath(path);
      setPendingCreate(null);
    },
    finishRename: () => setRenamingPath(null),
  };

  return (
    <div className="h-full min-h-0 rounded-md border border-base-800 bg-base-900/70 flex flex-col overflow-hidden">
      <div className="h-10 px-3 border-b border-base-800 flex items-center gap-2">
        <FolderOpen size={15} className="text-(--color-accent-amber)" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">Files</div>
          <div className="text-[10px] text-base-500 truncate" title={root}>
            {root}
          </div>
        </div>
        <button
          onClick={() => ctx.startCreate(root, "file")}
          className="h-7 w-7 rounded-md text-base-500 hover:text-(--color-accent-green) hover:bg-base-800 flex items-center justify-center"
          title="New file"
        >
          <FilePlus size={13} />
        </button>
        <button
          onClick={() => ctx.startCreate(root, "folder")}
          className="h-7 w-7 rounded-md text-base-500 hover:text-(--color-accent-amber) hover:bg-base-800 flex items-center justify-center"
          title="New folder"
        >
          <FolderPlus size={13} />
        </button>
        <button
          onClick={ctx.refreshAll}
          className="h-7 w-7 rounded-md text-base-500 hover:text-base-200 hover:bg-base-800 flex items-center justify-center"
          title="Refresh"
        >
          <RefreshCw size={13} />
        </button>
        <button
          onClick={onClose}
          className="h-7 w-7 rounded-md text-base-500 hover:text-base-200 hover:bg-base-800 flex items-center justify-center"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      {error && (
        <div className="px-3 py-1 text-[11px] text-(--color-accent-red) font-mono whitespace-pre-wrap border-b border-base-800 bg-(--color-accent-red)/5">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto p-2">
        <TreeNode
          path={root}
          depth={0}
          forceRevision={revision}
          ctx={ctx}
          onError={setError}
          root
        />
      </div>
    </div>
  );
}

function TreeNode({
  path,
  depth,
  forceRevision,
  ctx,
  onError,
  root,
}: {
  path: string;
  depth: number;
  forceRevision: number;
  ctx: TreeContext;
  onError: (err: string | null) => void;
  root?: boolean;
}) {
  const [open] = useState(true);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .fsListDir(path)
      .then((items) => {
        if (cancelled) return;
        setEntries(items);
        setLoaded(true);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, open, forceRevision]);

  const isCreatingHere =
    ctx.pendingCreate?.parentPath.toLowerCase() === path.toLowerCase();

  const childContent = (
    <>
      {error && (
        <div className="px-2 py-1 text-xs text-(--color-accent-red)">{error}</div>
      )}
      {isCreatingHere && (
        <InlineCreate
          parentPath={path}
          kind={ctx.pendingCreate!.kind}
          depth={depth}
          onCancel={ctx.finishCreate}
          onError={onError}
          onCreated={() => {
            ctx.finishCreate();
            ctx.refreshAll();
          }}
        />
      )}
      {entries.map((entry) => (
        <EntryRow
          key={entry.path}
          entry={entry}
          depth={depth}
          forceRevision={forceRevision}
          ctx={ctx}
          onError={onError}
        />
      ))}
      {loaded && entries.length === 0 && !isCreatingHere && (
        <div
          className="px-2 py-2 text-xs text-base-600"
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          {root ? "No files." : "(empty)"}
        </div>
      )}
    </>
  );

  if (root || open) return <div>{childContent}</div>;
  return null;
}

function EntryRow({
  entry,
  depth,
  forceRevision,
  ctx,
  onError,
}: {
  entry: FsEntry;
  depth: number;
  forceRevision: number;
  ctx: TreeContext;
  onError: (err: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const isRenaming = ctx.renamingPath === entry.path;
  const closeEditorTab = useStore((s) => s.closeEditorTab);
  const editorTabs = useStore((s) => s.editorTabs);

  const click = async () => {
    if (entry.is_dir) {
      setOpen((v) => !v);
      return;
    }
    try {
      await openFileInEditor(entry.path);
    } catch (e) {
      console.error("open in editor failed, falling back to OS:", e);
      await api.openPathExternal(entry.path).catch((err) => console.error(err));
    }
  };

  const onDelete = async () => {
    const what = entry.is_dir ? "folder" : "file";
    const ok = window.confirm(
      `Delete ${what} "${entry.name}"?${entry.is_dir ? " This removes everything inside." : ""}`,
    );
    if (!ok) return;
    try {
      await api.fsDelete(entry.path);
      // Close any editor tabs whose path lives inside the deleted entry.
      for (const tab of editorTabs) {
        if (
          tab.path === entry.path ||
          tab.path.startsWith(entry.path.replace(/[\\/]+$/, "") + "/") ||
          tab.path.startsWith(entry.path.replace(/[\\/]+$/, "") + "\\")
        ) {
          closeEditorTab(tab.path);
        }
      }
      ctx.refreshAll();
      onError(null);
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <div>
      {isRenaming ? (
        <InlineEdit
          initial={entry.name}
          depth={depth}
          icon={
            entry.is_dir ? (
              <Folder size={14} className="text-(--color-accent-amber) shrink-0" />
            ) : (
              <FileText size={14} className="text-base-500 shrink-0" />
            )
          }
          onCancel={ctx.finishRename}
          onCommit={async (next) => {
            const trimmed = next.trim();
            if (!trimmed || trimmed === entry.name) {
              ctx.finishRename();
              return;
            }
            try {
              await api.fsRename(entry.path, trimmed);
              ctx.finishRename();
              ctx.refreshAll();
              onError(null);
            } catch (e) {
              onError(String(e));
            }
          }}
        />
      ) : (
        <div
          className="group flex items-center w-full h-7 rounded-md hover:bg-base-800/70 transition"
          style={{ paddingLeft: 6 + depth * 14, paddingRight: 4 }}
        >
          <button
            onClick={click}
            className="flex-1 min-w-0 flex items-center gap-1.5 text-left text-sm text-base-300"
            title={entry.path}
          >
            {entry.is_dir ? (
              <ChevronRight
                size={13}
                className={cn("text-base-500 transition", open && "rotate-90")}
              />
            ) : (
              <span className="w-[13px]" />
            )}
            {entry.is_dir ? (
              open ? (
                <FolderOpen size={14} className="text-(--color-accent-amber) shrink-0" />
              ) : (
                <Folder size={14} className="text-(--color-accent-amber) shrink-0" />
              )
            ) : (
              <FileText size={14} className="text-base-500 shrink-0" />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
          <div className="shrink-0 flex items-center opacity-0 group-hover:opacity-100 transition">
            {entry.is_dir && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(true);
                    ctx.startCreate(entry.path, "file");
                  }}
                  className="h-5 w-5 rounded text-base-500 hover:text-(--color-accent-green) hover:bg-base-800 flex items-center justify-center"
                  title="New file in this folder"
                >
                  <FilePlus size={11} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(true);
                    ctx.startCreate(entry.path, "folder");
                  }}
                  className="h-5 w-5 rounded text-base-500 hover:text-(--color-accent-amber) hover:bg-base-800 flex items-center justify-center"
                  title="New folder in this folder"
                >
                  <FolderPlus size={11} />
                </button>
              </>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                ctx.startRename(entry.path);
              }}
              className="h-5 w-5 rounded text-base-500 hover:text-(--color-accent-cyan) hover:bg-base-800 flex items-center justify-center"
              title="Rename"
            >
              <Pencil size={11} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="h-5 w-5 rounded text-base-500 hover:text-(--color-accent-red) hover:bg-base-800 flex items-center justify-center"
              title="Delete"
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      )}
      {entry.is_dir && open && (
        <TreeNode
          path={entry.path}
          depth={depth + 1}
          forceRevision={forceRevision}
          ctx={ctx}
          onError={onError}
        />
      )}
    </div>
  );
}

function InlineCreate({
  parentPath,
  kind,
  depth,
  onCancel,
  onCreated,
  onError,
}: {
  parentPath: string;
  kind: "file" | "folder";
  depth: number;
  onCancel: () => void;
  onCreated: () => void;
  onError: (err: string | null) => void;
}) {
  return (
    <InlineEdit
      initial=""
      depth={depth + 1}
      placeholder={kind === "file" ? "filename.ext" : "folder-name"}
      icon={
        kind === "folder" ? (
          <Folder size={14} className="text-(--color-accent-amber) shrink-0" />
        ) : (
          <FileText size={14} className="text-base-500 shrink-0" />
        )
      }
      onCancel={onCancel}
      onCommit={async (name) => {
        const trimmed = name.trim();
        if (!trimmed) {
          onCancel();
          return;
        }
        const sep = parentPath.includes("\\") && !parentPath.includes("/") ? "\\" : "/";
        const fullPath = `${parentPath.replace(/[\\/]+$/, "")}${sep}${trimmed}`;
        try {
          if (kind === "file") {
            const created = await api.fsCreateFile(fullPath);
            onCreated();
            onError(null);
            await openFileInEditor(created).catch(() => {});
          } else {
            await api.fsCreateDir(fullPath);
            onCreated();
            onError(null);
          }
        } catch (e) {
          onError(String(e));
        }
      }}
    />
  );
}

function InlineEdit({
  initial,
  depth,
  icon,
  placeholder,
  onCancel,
  onCommit,
}: {
  initial: string;
  depth: number;
  icon: React.ReactNode;
  placeholder?: string;
  onCancel: () => void;
  onCommit: (value: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Place cursor before extension for rename ergonomics.
    const dot = initial.lastIndexOf(".");
    if (dot > 0) {
      el.setSelectionRange(0, dot);
    } else {
      el.select();
    }
  }, [initial]);

  return (
    <div
      className="flex items-center gap-1.5 h-7 rounded-md bg-base-950 border border-(--color-accent-cyan)/40"
      style={{ paddingLeft: 6 + depth * 14, paddingRight: 4 }}
    >
      <span className="w-[13px]" />
      {icon}
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => onCommit(value)}
        className="flex-1 bg-transparent text-sm font-mono outline-none text-base-100"
      />
    </div>
  );
}
