import { useEffect, useMemo, useState } from "react";
import {
  X, BookOpen, Terminal as TerminalIcon, Plus, Trash2, Save,
  RefreshCw, Globe, Folder, AlertTriangle, RotateCcw,
} from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import type { SkillEntry, SkillScope } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  cwd: string;
  agentName: string;
  /// Optional: when supplied, the dialog can offer a "Restart this agent"
  /// button after a save so changes take effect immediately.
  onRequestRestart?: () => void;
}

type Tab = "skill" | "command";

export function SkillsDialog({
  open, onClose, cwd, agentName, onRequestRestart,
}: Props) {
  const [tab, setTab] = useState<Tab>("skill");
  const [entries, setEntries] = useState<SkillEntry[]>([]);
  const [selected, setSelected] = useState<SkillEntry | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftScope, setDraftScope] = useState<SkillScope>("project");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedRecently, setSavedRecently] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await api.skillsList(cwd);
      setEntries(list);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    refresh();
    setSelected(null);
    setCreating(false);
    setDraftName("");
    setDraftBody("");
    setDirty(false);
    setSavedRecently(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cwd]);

  const filtered = useMemo(
    () => entries.filter((e) => e.kind === tab).sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === "global" ? -1 : 1;
      return a.name.localeCompare(b.name);
    }),
    [entries, tab],
  );

  const startCreate = () => {
    setCreating(true);
    setSelected(null);
    setDraftName("");
    setDraftScope("project");
    api.skillsDefaultBody(tab, "new").then((body) => {
      setDraftBody(body);
      setDirty(true);
      setSavedRecently(false);
    });
  };

  const startEdit = (e: SkillEntry) => {
    setCreating(false);
    setSelected(e);
    setDraftName(e.name);
    setDraftBody(e.body);
    setDraftScope(e.scope);
    setDirty(false);
    setSavedRecently(false);
  };

  const onSave = async () => {
    if (!draftName.trim()) {
      setError("Name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await api.skillsSave(
        cwd, tab, draftScope, draftName.trim(), draftBody,
      );
      await refresh();
      setSelected(saved);
      setCreating(false);
      setDirty(false);
      setSavedRecently(true);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!selected) return;
    if (!confirm(`Delete ${selected.kind} "${selected.name}"?\n${selected.path}`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.skillsDelete(selected.path);
      await refresh();
      setSelected(null);
      setDraftName("");
      setDraftBody("");
      setSavedRecently(true);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-950/80 backdrop-blur-sm">
      <div className="glass rounded-xl w-[1000px] max-w-[95vw] h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-base-800 flex items-center justify-between shrink-0">
          <div className="text-sm font-semibold tracking-wide flex items-center gap-2">
            <BookOpen size={14} className="text-(--color-accent-cyan)" />
            SKILLS &amp; COMMANDS
            <span className="text-base-500 text-[11px] font-normal ml-2">
              for @{agentName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={refresh}
              disabled={busy}
              className="text-base-500 hover:text-base-200 disabled:opacity-40"
              title="Refresh"
            >
              <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
            </button>
            <button onClick={onClose} className="text-base-500 hover:text-base-200">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-4 pt-3 shrink-0 flex items-center gap-1">
          <TabBtn active={tab === "skill"} onClick={() => { setTab("skill"); setSelected(null); setCreating(false); }}>
            <BookOpen size={12} /> Skills ({entries.filter((e) => e.kind === "skill").length})
          </TabBtn>
          <TabBtn active={tab === "command"} onClick={() => { setTab("command"); setSelected(null); setCreating(false); }}>
            <TerminalIcon size={12} /> Slash Commands ({entries.filter((e) => e.kind === "command").length})
          </TabBtn>
        </div>

        {/* Body: list + editor */}
        <div className="flex-1 flex min-h-0 p-3 gap-3">
          {/* Left: list */}
          <div className="w-72 shrink-0 border border-base-800 rounded-md flex flex-col bg-base-900/40">
            <button
              onClick={startCreate}
              className="m-2 px-2 py-1.5 text-xs rounded-md bg-(--color-accent-cyan)/15 hover:bg-(--color-accent-cyan)/25 border border-(--color-accent-cyan)/30 text-(--color-accent-cyan) flex items-center justify-center gap-1.5"
            >
              <Plus size={12} /> New {tab}
            </button>
            <div className="flex-1 overflow-y-auto px-1 pb-1 space-y-0.5">
              {filtered.length === 0 && !creating && (
                <div className="text-xs text-base-600 italic p-3 text-center">
                  No {tab}s yet. Click "New {tab}" above.
                </div>
              )}
              {filtered.map((e) => (
                <button
                  key={e.path}
                  onClick={() => startEdit(e)}
                  className={cn(
                    "w-full text-left px-2 py-1.5 rounded transition group",
                    selected?.path === e.path
                      ? "bg-(--color-accent-cyan)/15 border border-(--color-accent-cyan)/30"
                      : "hover:bg-base-800/60 border border-transparent",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {e.scope === "global" ? (
                      <Globe size={10} className="text-(--color-accent-violet) shrink-0" />
                    ) : (
                      <Folder size={10} className="text-(--color-accent-cyan) shrink-0" />
                    )}
                    <span className="text-xs font-medium truncate">{e.name}</span>
                  </div>
                  {e.description && (
                    <div className="text-[10px] text-base-500 truncate ml-4 mt-0.5">
                      {e.description}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Right: editor */}
          <div className="flex-1 min-w-0 border border-base-800 rounded-md bg-base-900/40 flex flex-col">
            {!selected && !creating ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-base-500">
                <BookOpen size={24} className="mb-2 opacity-40" />
                <div className="text-sm">Select a {tab} on the left, or create a new one.</div>
                <div className="text-[11px] text-base-600 mt-2 max-w-md">
                  {tab === "skill"
                    ? "Skills auto-load when an agent starts; the model decides when to invoke them based on the description."
                    : "Slash commands appear under /help in the agent. The body becomes the prompt sent when the user runs the command."}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0">
                {/* Editor header */}
                <div className="p-3 border-b border-base-800 space-y-2">
                  <div className="grid grid-cols-[1fr_140px] gap-2">
                    <Field label="Name">
                      <input
                        value={draftName}
                        onChange={(e) => { setDraftName(e.target.value); setDirty(true); setSavedRecently(false); }}
                        placeholder={tab === "skill" ? "my-skill" : "build (or git:commit for nested)"}
                        className="input font-mono text-xs"
                      />
                    </Field>
                    <Field label="Scope">
                      <select
                        value={draftScope}
                        onChange={(e) => { setDraftScope(e.target.value as SkillScope); setDirty(true); setSavedRecently(false); }}
                        className="input text-xs"
                        disabled={!creating /* can't move existing files between scopes */}
                      >
                        <option value="project">Project (this cwd)</option>
                        <option value="global">Global (~/.claude)</option>
                      </select>
                    </Field>
                  </div>
                  {selected && (
                    <div className="text-[10px] text-base-500 font-mono truncate" title={selected.path}>
                      {selected.path}
                    </div>
                  )}
                </div>

                {/* Body editor */}
                <div className="flex-1 min-h-0 p-3">
                  <textarea
                    value={draftBody}
                    onChange={(e) => { setDraftBody(e.target.value); setDirty(true); setSavedRecently(false); }}
                    spellCheck={false}
                    className="w-full h-full resize-none bg-base-950 border border-base-700 rounded-md p-3 text-xs font-mono outline-none focus:border-(--color-accent-cyan)/50"
                  />
                </div>

                {/* Footer */}
                <div className="p-3 border-t border-base-800 flex items-center gap-2">
                  {selected && !creating && (
                    <button
                      onClick={onDelete}
                      disabled={busy}
                      className="px-2 py-1.5 text-xs rounded-md text-(--color-accent-red) hover:bg-(--color-accent-red)/10 border border-(--color-accent-red)/30 flex items-center gap-1.5"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  )}
                  {savedRecently && onRequestRestart && (
                    <button
                      onClick={() => {
                        onRequestRestart();
                        setSavedRecently(false);
                      }}
                      className="px-2 py-1.5 text-xs rounded-md bg-(--color-accent-amber)/15 hover:bg-(--color-accent-amber)/25 border border-(--color-accent-amber)/30 text-(--color-accent-amber) flex items-center gap-1.5"
                      title="Claude CLI loads skills/commands once at startup. Restart the agent so it picks up your changes."
                    >
                      <RotateCcw size={12} /> Restart @{agentName} to load changes
                    </button>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {dirty && (
                      <span className="text-[10px] text-(--color-accent-amber) flex items-center gap-1">
                        <AlertTriangle size={10} /> unsaved
                      </span>
                    )}
                    <button
                      onClick={onSave}
                      disabled={busy || !dirty || !draftName.trim()}
                      className="px-3 py-1.5 text-xs rounded-md bg-(--color-accent-cyan)/20 hover:bg-(--color-accent-cyan)/30 border border-(--color-accent-cyan)/40 text-(--color-accent-cyan) disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                    >
                      <Save size={12} /> Save
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="mx-3 mb-3 p-2 rounded-md bg-(--color-accent-red)/10 border border-(--color-accent-red)/30 text-[11px] text-(--color-accent-red) flex items-start gap-2">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <style>{`
          .input {
            width: 100%;
            background: var(--color-base-950);
            border: 1px solid var(--color-base-700);
            border-radius: 6px;
            padding: 6px 10px;
            outline: none;
          }
          .input:focus { border-color: color-mix(in oklch, var(--color-accent-cyan) 50%, transparent); }
          .input:disabled { opacity: 0.5; cursor: not-allowed; }
        `}</style>
      </div>
    </div>
  );
}

function TabBtn({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 text-xs rounded-t-md flex items-center gap-1.5 border-b-2 transition",
        active
          ? "text-(--color-accent-cyan) border-(--color-accent-cyan)"
          : "text-base-400 hover:text-base-200 border-transparent",
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] tracking-wider text-base-500 mb-1 uppercase">{label}</div>
      {children}
    </div>
  );
}
