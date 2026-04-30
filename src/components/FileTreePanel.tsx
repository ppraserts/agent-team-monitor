import { useEffect, useState } from "react";
import { ChevronRight, FileText, Folder, FolderOpen, RefreshCw, X } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import type { FsEntry } from "../types";

interface Props {
  root: string;
  onClose: () => void;
}

export function FileTreePanel({ root, onClose }: Props) {
  const [revision, setRevision] = useState(0);

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
          onClick={() => setRevision((v) => v + 1)}
          className="h-7 w-7 rounded-md text-base-500 hover:text-base-200 hover:bg-base-800 flex items-center justify-center"
          title="Refresh file tree"
        >
          <RefreshCw size={13} />
        </button>
        <button
          onClick={onClose}
          className="h-7 w-7 rounded-md text-base-500 hover:text-base-200 hover:bg-base-800 flex items-center justify-center"
          title="Close file tree"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2">
        <TreeNode path={root} depth={0} forceRevision={revision} root />
      </div>
    </div>
  );
}

function TreeNode({
  path,
  depth,
  forceRevision,
  root,
}: {
  path: string;
  depth: number;
  forceRevision: number;
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

  if (root) {
    return (
      <div>
        {error && <div className="px-2 py-1 text-xs text-(--color-accent-red)">{error}</div>}
        {entries.map((entry) => (
          <EntryRow
            key={entry.path}
            entry={entry}
            depth={depth}
            forceRevision={forceRevision}
          />
        ))}
        {loaded && entries.length === 0 && (
          <div className="px-2 py-2 text-xs text-base-600">No files.</div>
        )}
      </div>
    );
  }

  return open ? (
    <div>
      {error && <div className="px-2 py-1 text-xs text-(--color-accent-red)">{error}</div>}
      {entries.map((entry) => (
        <EntryRow
          key={entry.path}
          entry={entry}
          depth={depth}
          forceRevision={forceRevision}
        />
      ))}
    </div>
  ) : null;
}

function EntryRow({
  entry,
  depth,
  forceRevision,
}: {
  entry: FsEntry;
  depth: number;
  forceRevision: number;
}) {
  const [open, setOpen] = useState(false);

  const click = async () => {
    if (entry.is_dir) {
      setOpen((v) => !v);
      return;
    }
    await api.openPathExternal(entry.path).catch((e) => console.error(e));
  };

  return (
    <div>
      <button
        onClick={click}
        className="w-full h-7 rounded-md flex items-center gap-1.5 text-left text-sm text-base-300 hover:bg-base-800/70 transition"
        style={{ paddingLeft: 6 + depth * 14 }}
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
      {entry.is_dir && open && (
        <TreeNode path={entry.path} depth={depth + 1} forceRevision={forceRevision} />
      )}
    </div>
  );
}
