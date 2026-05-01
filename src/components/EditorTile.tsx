import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { Circle, FileText, Loader2, Save, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useStore } from "../store";

interface Props {
  onClose?: () => void;
}

export function EditorTile({ onClose }: Props) {
  const { tabs, activePath } = useStore(
    useShallow((s) => ({
      tabs: s.editorTabs,
      activePath: s.activeEditorPath,
    })),
  );
  const setActiveEditorPath = useStore((s) => s.setActiveEditorPath);
  const closeEditorTab = useStore((s) => s.closeEditorTab);
  const markEditorDirty = useStore((s) => s.markEditorDirty);
  const recordEditorSave = useStore((s) => s.recordEditorSave);

  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const viewStateRef = useRef<Map<string, monaco.editor.ICodeEditorViewState | null>>(
    new Map(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Mount the editor once ----
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      automaticLayout: true,
      theme: "vs-dark",
      fontSize: 13,
      fontFamily:
        '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      minimap: { enabled: true, renderCharacters: false },
      smoothScrolling: true,
      scrollBeyondLastLine: false,
      wordWrap: "off",
      tabSize: 2,
      detectIndentation: true,
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      formatOnPaste: true,
    });
    editorRef.current = editor;

    // Save command (Ctrl+S / Cmd+S)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void doSave();
    });

    return () => {
      editor.dispose();
      editorRef.current = null;
      for (const m of modelsRef.current.values()) m.dispose();
      modelsRef.current.clear();
      viewStateRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Swap models when active tab or tab list changes ----
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    // Persist view state of the previously bound model so cursor/scroll come back.
    const current = editor.getModel();
    if (current) {
      const prevPath = current.uri.path.replace(/^\//, "");
      viewStateRef.current.set(prevPath, editor.saveViewState());
    }

    if (!activePath) {
      editor.setModel(null);
      return;
    }

    const tab = tabs.find((t) => t.path === activePath);
    if (!tab) {
      editor.setModel(null);
      return;
    }

    let model = modelsRef.current.get(activePath);
    if (!model) {
      model = monaco.editor.createModel(
        tab.savedContent,
        languageOf(activePath),
        monaco.Uri.file(activePath),
      );
      modelsRef.current.set(activePath, model);
      // Track dirty + value changes against the last saved snapshot.
      model.onDidChangeContent(() => {
        const m = modelsRef.current.get(activePath);
        if (!m) return;
        const live = m.getValue();
        const t = useStore.getState().editorTabs.find((x) => x.path === activePath);
        if (!t) return;
        const dirty = live !== t.savedContent;
        if (t.isDirty !== dirty) markEditorDirty(activePath, dirty);
      });
    }
    editor.setModel(model);

    const restored = viewStateRef.current.get(activePath);
    if (restored) editor.restoreViewState(restored);
    editor.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, tabs.length]);

  // ---- Drop models for tabs that were closed ----
  useEffect(() => {
    const openPaths = new Set(tabs.map((t) => t.path));
    for (const path of Array.from(modelsRef.current.keys())) {
      if (!openPaths.has(path)) {
        modelsRef.current.get(path)?.dispose();
        modelsRef.current.delete(path);
        viewStateRef.current.delete(path);
      }
    }
  }, [tabs]);

  const doSave = async () => {
    const editor = editorRef.current;
    const path = useStore.getState().activeEditorPath;
    if (!editor || !path) return;
    const model = modelsRef.current.get(path);
    if (!model) return;
    const content = model.getValue();
    setSaving(true);
    setError(null);
    try {
      const mtime = await api.fsWriteFile(path, content);
      recordEditorSave(path, content, mtime);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const closeTab = async (path: string) => {
    const tab = tabs.find((t) => t.path === path);
    if (tab?.isDirty) {
      const ok = window.confirm(
        `${shortName(path)} has unsaved changes. Close anyway?`,
      );
      if (!ok) return;
    }
    closeEditorTab(path);
  };

  const activeTab = useMemo(
    () => tabs.find((t) => t.path === activePath) ?? null,
    [tabs, activePath],
  );

  return (
    <div className="flex flex-col h-full bg-base-950 border border-(--color-accent-amber)/30 rounded-lg overflow-hidden">
      <div className="px-2 h-9 border-b border-base-800 flex items-stretch gap-0 bg-base-900/80 overflow-x-auto">
        {tabs.length === 0 ? (
          <div className="flex items-center gap-1.5 px-3 text-[11px] text-base-500">
            <FileText size={12} /> Editor — open a file from Files or Source Control
          </div>
        ) : (
          tabs.map((t) => {
            const isActive = t.path === activePath;
            return (
              <div
                key={t.path}
                onClick={() => setActiveEditorPath(t.path)}
                className={cn(
                  "group flex items-center gap-1.5 px-2 text-xs border-r border-base-800 cursor-pointer transition shrink-0",
                  isActive
                    ? "bg-base-950 text-base-100 border-b-2 border-b-(--color-accent-amber)"
                    : "text-base-400 hover:bg-base-800/50",
                )}
                title={t.path}
              >
                <FileText size={11} className="shrink-0 text-base-500" />
                <span className="truncate max-w-48 font-mono">
                  {shortName(t.path)}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.path);
                  }}
                  className={cn(
                    "h-4 w-4 rounded flex items-center justify-center shrink-0 transition",
                    t.isDirty
                      ? "text-(--color-accent-amber) hover:bg-base-800"
                      : "text-base-500 opacity-0 group-hover:opacity-100 hover:bg-base-800",
                  )}
                  title={t.isDirty ? "Unsaved — click to close" : "Close"}
                >
                  {t.isDirty ? <Circle size={8} fill="currentColor" /> : <X size={11} />}
                </button>
              </div>
            );
          })
        )}
        <div className="ml-auto flex items-center gap-1 px-1 shrink-0">
          {activeTab && (
            <button
              onClick={() => doSave()}
              disabled={saving || !activeTab.isDirty}
              className={cn(
                "h-7 px-2 rounded text-[11px] flex items-center gap-1 transition border",
                activeTab.isDirty
                  ? "border-(--color-accent-amber)/50 text-(--color-accent-amber) hover:bg-(--color-accent-amber)/10"
                  : "border-base-700 text-base-500 cursor-not-allowed",
              )}
              title="Save (Ctrl+S)"
            >
              {saving ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Save size={11} />
              )}
              Save
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="h-7 w-7 rounded text-base-500 hover:text-base-200 hover:bg-base-800 flex items-center justify-center"
              title="Close editor pane"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="px-3 py-1 text-[11px] text-(--color-accent-red) font-mono whitespace-pre-wrap border-b border-base-800 bg-(--color-accent-red)/5">
          {error}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <div ref={containerRef} className="h-full w-full" />
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-base-600 pointer-events-none">
            No file open.
          </div>
        )}
      </div>
    </div>
  );
}

function shortName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function languageOf(path: string): string {
  const lower = path.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
    case "jsonc":
      return "json";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "go":
      return "go";
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "rb":
      return "ruby";
    case "php":
      return "php";
    case "cs":
      return "csharp";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "h":
      return "cpp";
    case "c":
      return "c";
    case "swift":
      return "swift";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "less":
      return "less";
    case "html":
    case "htm":
      return "html";
    case "xml":
    case "svg":
      return "xml";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "ini";
    case "md":
    case "markdown":
      return "markdown";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "ps1":
    case "psm1":
      return "powershell";
    case "sql":
      return "sql";
    case "graphql":
    case "gql":
      return "graphql";
    case "dockerfile":
      return "dockerfile";
    default:
      if (lower.endsWith("dockerfile")) return "dockerfile";
      return "plaintext";
  }
}
