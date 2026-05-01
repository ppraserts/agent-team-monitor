import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Loader2, RotateCw, X } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import type { GitFileChange } from "../types";

interface Props {
  cwd: string;
  file: GitFileChange;
  staged: boolean;
  onClose: () => void;
  onAfterAction?: () => void;
}

export function GitDiffDialog({ cwd, file, staged, onClose, onAfterAction }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = () => {
    setLoading(true);
    setError(null);
    api
      .gitDiff(cwd, {
        path: file.path,
        staged,
        untracked: file.is_untracked,
      })
      .then((t) => setText(t))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, file.path, staged, file.is_untracked]);

  const lines = useMemo(() => parseDiff(text ?? ""), [text]);

  const wrap = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      onAfterAction?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-lg border border-base-700 bg-base-950 shadow-2xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-base-800 flex items-center gap-3 bg-base-900/80">
          <span
            className={cn(
              "px-1.5 rounded font-mono text-[10px] border",
              statusBadge(file).className,
            )}
            title={`${file.index_status} / ${file.work_status}`}
          >
            {statusBadge(file).label}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-mono truncate" title={file.path}>
              {file.path}
            </div>
            <div className="text-[10px] text-base-500">
              {staged ? "Staged changes" : file.is_untracked ? "Untracked file" : "Working tree changes"}
            </div>
          </div>
          {!file.is_untracked && (
            staged ? (
              <button
                onClick={() => wrap("unstage", () => api.gitUnstage(cwd, [file.path]))}
                disabled={!!busy}
                className="text-xs px-2 py-1 rounded border border-base-700 hover:border-(--color-accent-cyan)/40 hover:bg-base-800 transition flex items-center gap-1 disabled:opacity-50"
                title="Unstage this file"
              >
                <ArrowDownToLine size={12} /> Unstage
              </button>
            ) : (
              <button
                onClick={() => wrap("stage", () => api.gitStage(cwd, [file.path]))}
                disabled={!!busy}
                className="text-xs px-2 py-1 rounded border border-(--color-accent-green)/40 text-(--color-accent-green) hover:bg-(--color-accent-green)/10 transition flex items-center gap-1 disabled:opacity-50"
                title="Stage this file"
              >
                <ArrowUpFromLine size={12} /> Stage
              </button>
            )
          )}
          <button
            onClick={reload}
            disabled={loading}
            className="h-7 w-7 rounded-md text-base-500 hover:text-base-200 hover:bg-base-800 flex items-center justify-center"
            title="Reload diff"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} />}
          </button>
          <button
            onClick={onClose}
            className="h-7 w-7 rounded-md text-base-500 hover:text-base-200 hover:bg-base-800 flex items-center justify-center"
            title="Close (Esc)"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto bg-base-950">
          {error && (
            <div className="p-3 text-xs text-(--color-accent-red) font-mono whitespace-pre-wrap">
              {error}
            </div>
          )}
          {!error && !loading && lines.length === 0 && (
            <div className="p-6 text-center text-xs text-base-500">
              No diff output. The file may be binary, identical, or already committed.
            </div>
          )}
          {!error && lines.length > 0 && (
            <table className="w-full text-xs font-mono border-collapse">
              <tbody>
                {lines.map((ln, i) => (
                  <tr key={i} className={rowClassFor(ln.kind)}>
                    <td className="px-2 py-0.5 text-right text-base-600 select-none w-12 border-r border-base-800/60">
                      {ln.oldNo ?? ""}
                    </td>
                    <td className="px-2 py-0.5 text-right text-base-600 select-none w-12 border-r border-base-800/60">
                      {ln.newNo ?? ""}
                    </td>
                    <td className="px-2 py-0.5 whitespace-pre overflow-hidden">
                      <span className="select-none mr-1 text-base-600">{prefixFor(ln.kind)}</span>
                      {ln.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

type DiffLine = {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

function parseDiff(raw: string): DiffLine[] {
  if (!raw) return [];
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      out.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename ") ||
      line.startsWith("Binary files")
    ) {
      out.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith("+")) {
      out.push({
        kind: "add",
        text: line.slice(1),
        oldNo: null,
        newNo: newNo++,
      });
    } else if (line.startsWith("-")) {
      out.push({
        kind: "del",
        text: line.slice(1),
        oldNo: oldNo++,
        newNo: null,
      });
    } else if (line.startsWith(" ")) {
      out.push({
        kind: "ctx",
        text: line.slice(1),
        oldNo: oldNo++,
        newNo: newNo++,
      });
    }
  }
  return out;
}

function rowClassFor(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "bg-(--color-accent-green)/10 text-(--color-accent-green)";
    case "del":
      return "bg-(--color-accent-red)/10 text-(--color-accent-red)";
    case "hunk":
      return "bg-base-900 text-(--color-accent-violet) border-y border-base-800";
    case "meta":
      return "bg-base-900/60 text-base-500 italic";
    default:
      return "text-base-300";
  }
}

function prefixFor(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "+";
    case "del":
      return "-";
    case "hunk":
    case "meta":
      return "";
    default:
      return " ";
  }
}

function statusBadge(file: GitFileChange): { label: string; className: string } {
  if (file.is_conflicted) {
    return {
      label: "!",
      className: "border-(--color-accent-red)/50 text-(--color-accent-red) bg-(--color-accent-red)/10",
    };
  }
  if (file.is_untracked) {
    return {
      label: "U",
      className: "border-(--color-accent-green)/50 text-(--color-accent-green) bg-(--color-accent-green)/10",
    };
  }
  const code = file.staged ? file.xy.charAt(0) : file.xy.charAt(1);
  switch (code) {
    case "M":
      return {
        label: "M",
        className: "border-(--color-accent-amber)/50 text-(--color-accent-amber) bg-(--color-accent-amber)/10",
      };
    case "A":
      return {
        label: "A",
        className: "border-(--color-accent-green)/50 text-(--color-accent-green) bg-(--color-accent-green)/10",
      };
    case "D":
      return {
        label: "D",
        className: "border-(--color-accent-red)/50 text-(--color-accent-red) bg-(--color-accent-red)/10",
      };
    case "R":
      return {
        label: "R",
        className: "border-(--color-accent-cyan)/50 text-(--color-accent-cyan) bg-(--color-accent-cyan)/10",
      };
    default:
      return {
        label: code || "?",
        className: "border-base-600 text-base-400 bg-base-800",
      };
  }
}
