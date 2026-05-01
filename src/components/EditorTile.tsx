import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "../lib/monaco-setup";
import * as monaco from "monaco-editor";
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  FileText,
  Loader2,
  Save,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { EDITOR_FILE_MIME, openFileInEditorDrop } from "../lib/editor";
import { useStore } from "../store";
import type { EditorDropZone, EditorLayout } from "../store";

interface Props {
  onClose?: () => void;
}

type DropZone = EditorDropZone;

// Custom MIME so the browser only accepts our own editor-tab drags as drops
// (text drags from outside the app don't accidentally trigger splits).
const TAB_MIME = "application/x-monitor-editor-tab";

function computeDropZone(rect: DOMRect, x: number, y: number): DropZone {
  const nx = (x - rect.left) / rect.width;
  const ny = (y - rect.top) / rect.height;
  const margin = 0.25;
  if (nx > margin && nx < 1 - margin && ny > margin && ny < 1 - margin) {
    return "center";
  }
  const distLeft = nx;
  const distRight = 1 - nx;
  const distTop = ny;
  const distBottom = 1 - ny;
  const min = Math.min(distLeft, distRight, distTop, distBottom);
  if (min === distLeft) return "left";
  if (min === distRight) return "right";
  if (min === distTop) return "top";
  return "bottom";
}

// One Monaco model per file path, shared across all editor groups so that
// edits in one pane appear live in another pane that has the same file open.
const sharedModels = new Map<string, monaco.editor.ITextModel>();

function getOrCreateModel(path: string, content: string): monaco.editor.ITextModel {
  let model = sharedModels.get(path);
  if (model && !model.isDisposed()) return model;
  model = monaco.editor.createModel(
    content,
    languageOf(path),
    monaco.Uri.file(path),
  );
  sharedModels.set(path, model);
  return model;
}

function disposeUnusedModels(activePaths: Set<string>) {
  for (const [path, model] of sharedModels) {
    if (!activePaths.has(path)) {
      model.dispose();
      sharedModels.delete(path);
    }
  }
}

export function EditorTile({ onClose }: Props) {
  const layout = useStore((s) => s.editorLayout);
  const groups = useStore((s) => s.editorGroups);

  // Drop models for files that aren't open in any group anymore.
  useEffect(() => {
    const live = new Set<string>();
    for (const g of Object.values(groups)) {
      for (const t of g.tabs) live.add(t.path);
    }
    disposeUnusedModels(live);
  }, [groups]);

  return (
    <div className="flex flex-col h-full bg-base-950 border border-(--color-accent-amber)/30 rounded-lg overflow-hidden relative">
      <LayoutNode layout={layout} path={[]} onCloseTile={onClose} />
    </div>
  );
}

function LayoutNode({
  layout,
  path,
  onCloseTile,
}: {
  layout: EditorLayout;
  path: number[];
  onCloseTile?: () => void;
}) {
  if (layout.kind === "leaf") {
    return <EditorPane groupId={layout.groupId} onCloseTile={onCloseTile} />;
  }
  return (
    <SplitContainer
      direction={layout.direction}
      sizes={layout.sizes}
      path={path}
      childCount={layout.children.length}
    >
      {layout.children.map((child, i) => (
        <LayoutNode
          key={leafKey(child, i)}
          layout={child}
          path={[...path, i]}
          onCloseTile={onCloseTile}
        />
      ))}
    </SplitContainer>
  );
}

function leafKey(layout: EditorLayout, fallback: number): string {
  if (layout.kind === "leaf") return layout.groupId;
  return `s${fallback}`;
}

function SplitContainer({
  direction,
  sizes,
  path,
  children,
  childCount,
}: {
  direction: "horizontal" | "vertical";
  sizes: number[];
  path: number[];
  children: React.ReactNode[];
  childCount: number;
}) {
  const resizeEditorSplit = useStore((s) => s.resizeEditorSplit);
  const containerRef = useRef<HTMLDivElement>(null);
  const isHorizontal = direction === "horizontal";

  const startResize = (gutterIndex: number, e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const total = isHorizontal ? rect.width : rect.height;
    const startCoord = isHorizontal ? e.clientX : e.clientY;
    const startSizes = [...sizes];

    const onMove = (ev: MouseEvent) => {
      const cur = isHorizontal ? ev.clientX : ev.clientY;
      const delta = ((cur - startCoord) / total) * 100;
      const next = [...startSizes];
      const left = next[gutterIndex];
      const right = next[gutterIndex + 1];
      const min = 8; // never collapse a pane below 8% via drag
      const sum = left + right;
      let newLeft = left + delta;
      newLeft = Math.max(min, Math.min(sum - min, newLeft));
      next[gutterIndex] = newLeft;
      next[gutterIndex + 1] = sum - newLeft;
      resizeEditorSplit(path, next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex-1 min-h-0 min-w-0 flex",
        isHorizontal ? "flex-row" : "flex-col",
      )}
    >
      {children.map((child, i) => (
        <Fragment key={i}>
          <div
            style={{
              flex: `0 0 ${sizes[i] ?? 100 / childCount}%`,
              minWidth: 0,
              minHeight: 0,
            }}
            className="flex"
          >
            {child}
          </div>
          {i < children.length - 1 && (
            <div
              onMouseDown={(e) => startResize(i, e)}
              className={cn(
                "shrink-0 bg-base-800 hover:bg-(--color-accent-amber)/60 transition relative",
                isHorizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
              )}
              title="Drag to resize"
            >
              <div
                className={cn(
                  "absolute",
                  isHorizontal ? "inset-y-0 -left-0.5 w-2" : "inset-x-0 -top-0.5 h-2",
                )}
              />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

function EditorPane({
  groupId,
  onCloseTile,
}: {
  groupId: string;
  onCloseTile?: () => void;
}) {
  const { group, isActiveGroup, totalGroups } = useStore(
    useShallow((s) => ({
      group: s.editorGroups[groupId],
      isActiveGroup: s.activeGroupId === groupId,
      totalGroups: Object.keys(s.editorGroups).length,
    })),
  );
  const setActiveEditorTab = useStore((s) => s.setActiveEditorTab);
  const setActiveGroup = useStore((s) => s.setActiveGroup);
  const closeEditorTab = useStore((s) => s.closeEditorTab);
  const reorderEditorTab = useStore((s) => s.reorderEditorTab);
  const splitEditorGroup = useStore((s) => s.splitEditorGroup);
  const closeEditorGroup = useStore((s) => s.closeEditorGroup);
  const markEditorDirty = useStore((s) => s.markEditorDirty);
  const recordEditorSave = useStore((s) => s.recordEditorSave);
  const dropTabIntoGroup = useStore((s) => s.dropTabIntoGroup);
  const isDraggingEditorTab = useStore((s) => s.isDraggingEditorTab);
  const isDraggingEditorFile = useStore((s) => s.isDraggingEditorFile);
  const draggingEditorFilePath = useStore((s) => s.draggingEditorFilePath);
  const setDraggingEditorTab = useStore((s) => s.setDraggingEditorTab);
  const setDraggingEditorFile = useStore((s) => s.setDraggingEditorFile);

  const containerRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const subRef = useRef<monaco.IDisposable | null>(null);
  const viewStateRef = useRef<Map<string, monaco.editor.ICodeEditorViewState | null>>(
    new Map(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [tabDrag, setTabDrag] = useState<{ path: string; overPath: string | null; placeAfter: boolean }>({
    path: "",
    overPath: null,
    placeAfter: false,
  });

  const tabs = group?.tabs ?? [];
  const activePath = group?.activePath ?? null;

  useEffect(() => {
    if (!isDraggingEditorFile && !isDraggingEditorTab) {
      setDropZone(null);
    }
  }, [isDraggingEditorFile, isDraggingEditorTab]);

  useEffect(() => {
    if (!isDraggingEditorFile || !draggingEditorFilePath) return;
    const pane = paneRef.current;
    if (!pane) return;

    const zoneAt = (x: number, y: number) => {
      const rect = pane.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        return null;
      }
      return computeDropZone(rect, x, y);
    };

    const onMove = (e: MouseEvent) => {
      setDropZone(zoneAt(e.clientX, e.clientY));
    };
    const onUp = (e: MouseEvent) => {
      const zone = zoneAt(e.clientX, e.clientY);
      if (zone) {
        openFileInEditorDrop(draggingEditorFilePath, groupId, zone).catch((err) => {
          console.error("file mouse drop open failed", err);
        });
      }
      setDropZone(null);
      setDraggingEditorFile(false, null);
    };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };
  }, [draggingEditorFilePath, groupId, isDraggingEditorFile, setDraggingEditorFile]);

  // ---- Mount ----
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

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void doSave();
    });
    editor.onDidFocusEditorText(() => setActiveGroup(groupId));

    return () => {
      subRef.current?.dispose();
      subRef.current = null;
      editor.dispose();
      editorRef.current = null;
      viewStateRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Bind active model ----
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const current = editor.getModel();
    if (current) {
      const prevPath = current.uri.path.replace(/^\//, "");
      viewStateRef.current.set(prevPath, editor.saveViewState());
    }

    subRef.current?.dispose();
    subRef.current = null;

    if (!activePath) {
      editor.setModel(null);
      return;
    }
    const tab = tabs.find((t) => t.path === activePath);
    if (!tab) {
      editor.setModel(null);
      return;
    }

    const model = getOrCreateModel(activePath, tab.savedContent);
    editor.setModel(model);

    // Compare model contents against the saved snapshot for ALL groups that
    // have this file open, since they should share dirty state.
    subRef.current = model.onDidChangeContent(() => {
      const live = model.getValue();
      const allGroups = useStore.getState().editorGroups;
      for (const g of Object.values(allGroups)) {
        const t = g.tabs.find((x) => x.path === activePath);
        if (!t) continue;
        const dirty = live !== t.savedContent;
        if (t.isDirty !== dirty) markEditorDirty(g.id, activePath, dirty);
      }
    });

    const restored = viewStateRef.current.get(activePath);
    if (restored) editor.restoreViewState(restored);
    if (isActiveGroup) editor.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, tabs.length]);

  const doSave = async () => {
    const editor = editorRef.current;
    const path = useStore.getState().editorGroups[groupId]?.activePath;
    if (!editor || !path) return;
    const model = sharedModels.get(path);
    if (!model) return;
    const content = model.getValue();
    setSaving(true);
    setError(null);
    try {
      const mtime = await api.fsWriteFile(path, content);
      // Update savedContent across all groups holding this path.
      const allGroups = useStore.getState().editorGroups;
      for (const g of Object.values(allGroups)) {
        if (g.tabs.some((t) => t.path === path)) {
          recordEditorSave(g.id, path, content, mtime);
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const closeTab = (path: string) => {
    const tab = tabs.find((t) => t.path === path);
    if (tab?.isDirty) {
      const ok = window.confirm(
        `${shortName(path)} has unsaved changes. Close anyway?`,
      );
      if (!ok) return;
    }
    closeEditorTab(groupId, path);
  };

  const activeTab = useMemo(
    () => tabs.find((t) => t.path === activePath) ?? null,
    [tabs, activePath],
  );
  const activeTabIndex = activePath ? tabs.findIndex((t) => t.path === activePath) : -1;

  if (!group) return null;

  const onPaneDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement | null)?.closest("[data-editor-tab-strip]")) return;
    const hasEditorPayload =
      e.dataTransfer.types.includes(TAB_MIME) ||
      e.dataTransfer.types.includes(EDITOR_FILE_MIME) ||
      isDraggingEditorFile;
    if (!hasEditorPayload) return;
    e.preventDefault();
    e.stopPropagation();
    if (isDraggingEditorFile) {
      setDraggingEditorFile(true, draggingEditorFilePath);
    }
    e.dataTransfer.dropEffect =
      e.dataTransfer.types.includes(TAB_MIME) && !isDraggingEditorFile ? "move" : "copy";
    const rect = e.currentTarget.getBoundingClientRect();
    setDropZone(computeDropZone(rect, e.clientX, e.clientY));
  };
  const onPaneDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement | null)?.closest("[data-editor-tab-strip]")) return;
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDropZone(null);
    setDraggingEditorFile(false);
  };
  const onPaneDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement | null)?.closest("[data-editor-tab-strip]")) return;
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData(TAB_MIME);
    const droppedFile = e.dataTransfer.getData(EDITOR_FILE_MIME) || draggingEditorFilePath || "";
    const rect = e.currentTarget.getBoundingClientRect();
    const zone = computeDropZone(rect, e.clientX, e.clientY);
    setDropZone(null);
    setDraggingEditorTab(false);
    setDraggingEditorFile(false, null);
    if (raw) {
      try {
        const data = JSON.parse(raw) as { groupId: string; path: string };
        if (typeof data.groupId !== "string" || typeof data.path !== "string") return;
        dropTabIntoGroup(data.groupId, data.path, groupId, zone);
        return;
      } catch (err) {
        console.error("drop parse failed", err);
        return;
      }
    }
    if (!droppedFile) return;
    openFileInEditorDrop(droppedFile, groupId, zone).catch((err) => {
      console.error("file drop open failed", err);
    });
  };

  const onEmptyPaneDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (tabs.length !== 0) return;
    if (!e.dataTransfer.types.includes(EDITOR_FILE_MIME) && !draggingEditorFilePath) return;
    e.preventDefault();
    e.stopPropagation();
    const droppedFile = e.dataTransfer.getData(EDITOR_FILE_MIME) || draggingEditorFilePath || "";
    if (!droppedFile) return;
    setDropZone(null);
    setDraggingEditorFile(false, null);
    openFileInEditorDrop(droppedFile, groupId, "center").catch((err) => {
      console.error("empty pane file drop open failed", err);
    });
  };

  const onEmptyPaneDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (tabs.length !== 0) return;
    if (!e.dataTransfer.types.includes(EDITOR_FILE_MIME) && !draggingEditorFilePath) return;
    e.preventDefault();
    e.stopPropagation();
    setDropZone("center");
    setDraggingEditorFile(true, draggingEditorFilePath);
  };

  const onEmptyPaneDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (tabs.length !== 0) return;
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDropZone(null);
    setDraggingEditorFile(false, null);
  };

  return (
    <div
      ref={paneRef}
      onMouseDown={() => setActiveGroup(groupId)}
      onDragEnterCapture={onPaneDragOver}
      onDragOverCapture={onPaneDragOver}
      onDragLeaveCapture={onPaneDragLeave}
      onDropCapture={onPaneDrop}
      onDragEnter={onPaneDragOver}
      onDragOver={onPaneDragOver}
      onDragLeave={onPaneDragLeave}
      onDrop={onPaneDrop}
      className={cn(
        "flex flex-col h-full w-full min-h-0 min-w-0 bg-base-950 transition relative",
        isActiveGroup
          ? "ring-1 ring-(--color-accent-amber)/40"
          : "ring-1 ring-transparent",
      )}
    >
      <div
        data-editor-tab-strip
        className="px-2 h-9 border-b border-base-800 flex items-stretch gap-0 bg-base-900/80 overflow-x-auto"
      >
        {tabs.length === 0 ? (
          <div className="flex items-center gap-1.5 px-3 text-[11px] text-base-500">
            <FileText size={12} /> Empty editor pane
          </div>
        ) : (
          tabs.map((t) => {
            const isActive = t.path === activePath;
            return (
              <div
                key={t.path}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData(
                    TAB_MIME,
                    JSON.stringify({ groupId, path: t.path }),
                  );
                  e.dataTransfer.setData("text/plain", t.path);
                  setTabDrag({ path: t.path, overPath: null, placeAfter: false });
                  setDraggingEditorTab(true);
                }}
                onDragEnd={() => {
                  setTabDrag({ path: "", overPath: null, placeAfter: false });
                  setDraggingEditorTab(false);
                }}
                onDragOver={(e) => {
                  if (!isDraggingEditorTab || !tabDrag.path || tabDrag.path === t.path) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const placeAfter = e.clientX > rect.left + rect.width / 2;
                  setTabDrag({ path: tabDrag.path, overPath: t.path, placeAfter });
                }}
                onDragLeave={(e) => {
                  const next = e.relatedTarget as Node | null;
                  if (next && e.currentTarget.contains(next)) return;
                  setTabDrag((current) =>
                    current.overPath === t.path ? { path: current.path, overPath: null, placeAfter: false } : current,
                  );
                }}
                onDrop={(e) => {
                  if (!tabDrag.path || tabDrag.path === t.path) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  reorderEditorTab(groupId, tabDrag.path, t.path, e.clientX > rect.left + rect.width / 2);
                  setTabDrag({ path: "", overPath: null, placeAfter: false });
                  setDraggingEditorTab(false);
                }}
                onClick={() => setActiveEditorTab(groupId, t.path)}
                className={cn(
                  "group flex items-center gap-1.5 px-2 text-xs border-r border-base-800 cursor-grab active:cursor-grabbing transition shrink-0 relative",
                  isActive
                    ? "bg-base-950 text-base-100 border-b-2 border-b-(--color-accent-amber)"
                    : "text-base-400 hover:bg-base-800/50",
                )}
                title={`${t.path}\n(drag to split or move to another pane)`}
              >
                {tabDrag.overPath === t.path && (
                  <span
                    className={cn(
                      "absolute top-1 bottom-1 w-0.5 rounded-full bg-(--color-accent-amber)",
                      tabDrag.placeAfter ? "right-0" : "left-0",
                    )}
                  />
                )}
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
          {activeTab && tabs.length > 1 && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (activeTabIndex > 0) {
                    reorderEditorTab(groupId, activeTab.path, tabs[activeTabIndex - 1].path, false);
                  }
                }}
                disabled={activeTabIndex <= 0}
                className="h-7 w-7 rounded text-base-500 hover:text-(--color-accent-amber) hover:bg-base-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-base-500 flex items-center justify-center"
                title="Move tab left"
              >
                <ChevronLeft size={13} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (activeTabIndex >= 0 && activeTabIndex < tabs.length - 1) {
                    reorderEditorTab(groupId, activeTab.path, tabs[activeTabIndex + 1].path, true);
                  }
                }}
                disabled={activeTabIndex < 0 || activeTabIndex >= tabs.length - 1}
                className="h-7 w-7 rounded text-base-500 hover:text-(--color-accent-amber) hover:bg-base-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-base-500 flex items-center justify-center"
                title="Move tab right"
              >
                <ChevronRight size={13} />
              </button>
            </>
          )}
          {tabs.length > 0 && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  splitEditorGroup(groupId, "horizontal");
                }}
                className="h-7 w-7 rounded text-base-500 hover:text-(--color-accent-amber) hover:bg-base-800 flex items-center justify-center"
                title="Split right"
              >
                <SplitSquareHorizontal size={13} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  splitEditorGroup(groupId, "vertical");
                }}
                className="h-7 w-7 rounded text-base-500 hover:text-(--color-accent-amber) hover:bg-base-800 flex items-center justify-center"
                title="Split down"
              >
                <SplitSquareVertical size={13} />
              </button>
            </>
          )}
          {totalGroups > 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeEditorGroup(groupId);
              }}
              className="h-7 w-7 rounded text-base-500 hover:text-(--color-accent-red) hover:bg-base-800 flex items-center justify-center"
              title="Close this pane"
            >
              <X size={13} />
            </button>
          )}
          {totalGroups === 1 && onCloseTile && (
            <button
              onClick={onCloseTile}
              className="h-7 w-7 rounded text-base-500 hover:text-base-200 hover:bg-base-800 flex items-center justify-center"
              title="Close editor tile"
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
      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="h-full w-full" />
        {tabs.length === 0 && (
          <div
            className="absolute inset-0 flex items-center justify-center text-xs text-base-600"
            onDragOver={onEmptyPaneDragOver}
            onDragLeave={onEmptyPaneDragLeave}
            onDrop={onEmptyPaneDrop}
          >
            <span className="pointer-events-none">No file open in this pane.</span>
          </div>
        )}
        {/* Capture layer — only intercepts events while a tab is being dragged
             so Monaco keeps its normal click/scroll/select behavior the rest
             of the time. */}
        <div
          className={cn(
            "absolute inset-0",
            isDraggingEditorTab || isDraggingEditorFile ? "pointer-events-auto" : "pointer-events-none",
          )}
        >
          <DropZoneOverlay zone={dropZone} />
        </div>
        {!dropZone && (isDraggingEditorFile || isDraggingEditorTab) && (
          <div className="absolute inset-0 pointer-events-none border-2 border-dashed border-(--color-accent-amber)/30" />
        )}
      </div>
    </div>
  );
}

function DropZoneOverlay({ zone }: { zone: DropZone | null }) {
  if (!zone) return null;
  const base =
    "absolute pointer-events-none border-2 border-(--color-accent-amber) bg-(--color-accent-amber)/15 transition-all";
  let style: React.CSSProperties;
  switch (zone) {
    case "center":
      style = { inset: 8 };
      break;
    case "left":
      style = { top: 8, bottom: 8, left: 8, width: "50%" };
      break;
    case "right":
      style = { top: 8, bottom: 8, right: 8, width: "50%" };
      break;
    case "top":
      style = { top: 8, left: 8, right: 8, height: "50%" };
      break;
    case "bottom":
      style = { bottom: 8, left: 8, right: 8, height: "50%" };
      break;
  }
  return (
    <div className={base} style={style}>
      <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-wider text-(--color-accent-amber) font-mono">
        {zone === "center" ? "Move tab here" : `Split ${zone}`}
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
