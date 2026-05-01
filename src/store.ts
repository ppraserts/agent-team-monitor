import { create } from "zustand";
import type {
  AgentSnapshot,
  AgentStatus,
  AgentUsage,
  ChatMessage,
  PtySnapshot,
  VendorInfo,
  BoardCard,
  Mission,
  Workspace,
  WorkspaceContext,
} from "./types";

function workspaceKey(path: string): string {
  return path.replace(/^\\\\\?\\/, "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function dedupeWorkspaces(workspaces: Workspace[]): Workspace[] {
  const byPath = new Map<string, Workspace>();
  for (const workspace of workspaces) {
    const key = workspaceKey(workspace.root_path);
    const existing = byPath.get(key);
    if (!existing || new Date(workspace.last_opened_at).getTime() >= new Date(existing.last_opened_at).getTime()) {
      byPath.set(key, workspace);
    }
  }
  return Array.from(byPath.values()).sort((a, b) => (
    new Date(b.last_opened_at).getTime() - new Date(a.last_opened_at).getTime()
  ));
}

interface AgentRecord {
  snapshot: AgentSnapshot;
  messages: ChatMessage[];
}

export interface EditorTab {
  path: string;
  savedContent: string;
  mtimeMs: number;
  isDirty: boolean;
}

export interface EditorGroup {
  id: string;
  tabs: EditorTab[];
  activePath: string | null;
}

export type SplitDirection = "horizontal" | "vertical";
export type EditorDropZone = "center" | "left" | "right" | "top" | "bottom";

/// Tree of editor groups. Leaves are concrete groups; branches split into
/// children with relative sizes. The whole tree always has at least one leaf.
export type EditorLayout =
  | { kind: "leaf"; groupId: string }
  | {
      kind: "split";
      direction: SplitDirection;
      children: EditorLayout[];
      sizes: number[];
    };

interface State {
  agents: Record<string, AgentRecord>;
  ptys: Record<string, PtySnapshot>;
  vendors: VendorInfo[];
  homeDir: string | null;
  workspaces: Workspace[];
  missions: Mission[];
  activeWorkspace: WorkspaceContext | null;

  editorGroups: Record<string, EditorGroup>;
  editorLayout: EditorLayout;
  activeGroupId: string;
  editorVisible: boolean;
  isDraggingEditorTab: boolean;
  isDraggingEditorFile: boolean;
  draggingEditorFilePath: string | null;

  // UI state
  activeTileId: string | null; // agent or pty id
  layout: string[]; // ordered list of ids displayed in tile grid

  /// Decisions on approval proposals keyed by `${messageId}#${proposalIndex}`.
  /// Lives in-memory only — a new spawn / refresh clears them.
  proposalDecisions: Record<string, { decision: "approved" | "denied"; ts: string }>;

  /// Which board card each agent is currently working on. Set when the user
  /// clicks "Send to assignees" on a card; cleared when the card moves to
  /// the rightmost (done) column, the card is deleted, or the agent exits.
  /// In-memory only.
  agentCardLink: Record<string, { cardId: number; cardTitle: string; boardId: number }>;
  boardRevision: number;
  boardActivities: {
    id: string;
    agentId: string;
    action: string;
    ok: boolean;
    message: string;
    card: BoardCard | null;
    ts: string;
  }[];
  processActivities: {
    id: string;
    agentId: string;
    agentName: string | null;
    code: number | null;
    stderrTail: string[];
    ts: string;
  }[];
  chatClearBefore: Record<string, string>;
  activityClearBefore: string | null;

  // selectors / mutations
  setVendors: (v: VendorInfo[]) => void;
  setHomeDir: (h: string | null) => void;
  setWorkspaces: (workspaces: Workspace[]) => void;
  upsertWorkspace: (workspace: Workspace) => void;
  removeWorkspace: (id: string) => void;
  setMissions: (missions: Mission[]) => void;
  setActiveWorkspace: (workspace: WorkspaceContext | null) => void;
  upsertAgent: (snap: AgentSnapshot) => void;
  setStatus: (id: string, status: AgentStatus) => void;
  appendMessage: (id: string, msg: ChatMessage) => void;
  appendToolUse: (id: string, tool: string, input: unknown, ts: string) => void;
  applyUsage: (id: string, usage: AgentUsage) => void;
  removeAgent: (id: string) => void;

  upsertPty: (snap: PtySnapshot) => void;
  removePty: (id: string) => void;

  setActive: (id: string | null) => void;
  toggleInLayout: (id: string) => void;
  removeFromLayout: (id: string) => void;

  recordDecision: (key: string, decision: "approved" | "denied") => void;

  linkAgentsToCard: (
    agentIds: string[],
    cardId: number,
    cardTitle: string,
    boardId: number,
  ) => void;
  unlinkAgent: (agentId: string) => void;
  unlinkCard: (cardId: number) => void;
  appendBoardActivity: (
    agentId: string,
    action: string,
    ok: boolean,
    message: string,
    card: BoardCard | null,
    ts: string,
  ) => void;
  appendProcessActivity: (
    agentId: string,
    agentName: string | null,
    code: number | null,
    stderrTail: string[],
  ) => void;
  clearChatView: (agentId: string) => void;
  carryChatViewCutoff: (fromAgentId: string, toAgentId: string) => void;
  clearActivityView: () => void;

  openEditorTab: (
    path: string,
    content: string,
    mtimeMs: number,
    targetGroupId?: string,
  ) => void;
  closeEditorTab: (groupId: string, path: string) => void;
  reorderEditorTab: (groupId: string, path: string, targetPath: string, placeAfter: boolean) => void;
  setActiveEditorTab: (groupId: string, path: string) => void;
  setActiveGroup: (groupId: string) => void;
  splitEditorGroup: (groupId: string, direction: SplitDirection) => void;
  closeEditorGroup: (groupId: string) => void;
  dropTabIntoGroup: (
    fromGroupId: string,
    path: string,
    targetGroupId: string,
    zone: EditorDropZone,
  ) => void;
  openEditorDrop: (
    path: string,
    content: string,
    mtimeMs: number,
    targetGroupId: string,
    zone: EditorDropZone,
  ) => void;
  resizeEditorSplit: (path: number[], sizes: number[]) => void;
  setEditorVisible: (visible: boolean) => void;
  setDraggingEditorTab: (dragging: boolean) => void;
  setDraggingEditorFile: (dragging: boolean, path?: string | null) => void;
  markEditorDirty: (groupId: string, path: string, isDirty: boolean) => void;
  recordEditorSave: (
    groupId: string,
    path: string,
    savedContent: string,
    mtimeMs: number,
  ) => void;
}

export const useStore = create<State>((set) => ({
  agents: {},
  ptys: {},
  vendors: [],
  homeDir: null,
  workspaces: [],
  missions: [],
  activeWorkspace: null,
  editorGroups: { g0: { id: "g0", tabs: [], activePath: null } },
  editorLayout: { kind: "leaf", groupId: "g0" },
  activeGroupId: "g0",
  editorVisible: false,
  isDraggingEditorTab: false,
  isDraggingEditorFile: false,
  draggingEditorFilePath: null,
  activeTileId: null,
  layout: [],
  proposalDecisions: {},
  agentCardLink: {},
  boardRevision: 0,
  boardActivities: [],
  processActivities: [],
  chatClearBefore: {},
  activityClearBefore: null,

  setVendors: (v) => set({ vendors: v }),
  setHomeDir: (h) => set({ homeDir: h }),
  setWorkspaces: (workspaces) => set({ workspaces: dedupeWorkspaces(workspaces) }),
  upsertWorkspace: (workspace) =>
    set((s) => ({
      workspaces: dedupeWorkspaces(
        s.workspaces.some((w) => w.id === workspace.id)
          ? s.workspaces.map((w) => (w.id === workspace.id ? workspace : w))
          : [...s.workspaces, workspace],
      ),
    })),
  removeWorkspace: (id) =>
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== id),
      activeWorkspace: s.activeWorkspace?.id === id ? null : s.activeWorkspace,
    })),
  setMissions: (missions) => set({ missions }),
  setActiveWorkspace: (workspace) => set({ activeWorkspace: workspace }),

  upsertAgent: (snap) =>
    set((s) => {
      const existing = s.agents[snap.id];
      const layout = s.layout.includes(snap.id) ? s.layout : [...s.layout, snap.id];
      return {
        agents: {
          ...s.agents,
          [snap.id]: { snapshot: snap, messages: existing?.messages ?? [] },
        },
        layout,
        activeTileId: s.activeTileId ?? snap.id,
      };
    }),

  setStatus: (id, status) =>
    set((s) => {
      const r = s.agents[id];
      if (!r) return {};
      return {
        agents: {
          ...s.agents,
          [id]: { ...r, snapshot: { ...r.snapshot, status } },
        },
      };
    }),

  appendMessage: (id, msg) =>
    set((s) => {
      const r = s.agents[id];
      if (!r) return {};
      return {
        agents: {
          ...s.agents,
          [id]: {
            snapshot: { ...r.snapshot, message_count: r.snapshot.message_count + 1 },
            messages: [...r.messages, msg],
          },
        },
      };
    }),

  appendToolUse: (id, tool, input, ts) =>
    set((s) => {
      const r = s.agents[id];
      if (!r) return {};
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "tool",
        content: tool,
        ts,
        tool_name: tool,
        tool_input: input,
      };
      return {
        agents: { ...s.agents, [id]: { ...r, messages: [...r.messages, msg] } },
      };
    }),

  applyUsage: (id, usage) =>
    set((s) => {
      const r = s.agents[id];
      if (!r) return {};
      return {
        agents: {
          ...s.agents,
          [id]: { ...r, snapshot: { ...r.snapshot, usage } },
        },
      };
    }),

  removeAgent: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.agents;
      return {
        agents: rest,
        layout: s.layout.filter((x) => x !== id),
        activeTileId: s.activeTileId === id ? null : s.activeTileId,
      };
    }),

  upsertPty: (snap) =>
    set((s) => ({
      ptys: { ...s.ptys, [snap.id]: snap },
      layout: s.layout.includes(snap.id) ? s.layout : [...s.layout, snap.id],
      activeTileId: s.activeTileId ?? snap.id,
    })),

  removePty: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.ptys;
      return {
        ptys: rest,
        layout: s.layout.filter((x) => x !== id),
        activeTileId: s.activeTileId === id ? null : s.activeTileId,
      };
    }),

  setActive: (id) => set({ activeTileId: id }),
  toggleInLayout: (id) =>
    set((s) => {
      const visible = s.layout.includes(id);
      return {
        layout: visible ? s.layout.filter((x) => x !== id) : [...s.layout, id],
        activeTileId: visible && s.activeTileId === id ? null : s.activeTileId,
      };
    }),
  removeFromLayout: (id) =>
    set((s) => ({
      layout: s.layout.filter((x) => x !== id),
      activeTileId: s.activeTileId === id ? null : s.activeTileId,
    })),

  recordDecision: (key, decision) =>
    set((s) => ({
      proposalDecisions: {
        ...s.proposalDecisions,
        [key]: { decision, ts: new Date().toISOString() },
      },
    })),

  linkAgentsToCard: (agentIds, cardId, cardTitle, boardId) =>
    set((s) => {
      const next = { ...s.agentCardLink };
      for (const aid of agentIds) {
        next[aid] = { cardId, cardTitle, boardId };
      }
      return { agentCardLink: next };
    }),

  unlinkAgent: (agentId) =>
    set((s) => {
      if (!s.agentCardLink[agentId]) return {};
      const { [agentId]: _, ...rest } = s.agentCardLink;
      return { agentCardLink: rest };
    }),

  unlinkCard: (cardId) =>
    set((s) => {
      const next: typeof s.agentCardLink = {};
      for (const [aid, link] of Object.entries(s.agentCardLink)) {
        if (link.cardId !== cardId) next[aid] = link;
      }
      return { agentCardLink: next };
    }),

  appendBoardActivity: (agentId, action, ok, message, card, ts) =>
    set((s) => ({
      boardRevision: s.boardRevision + 1,
      boardActivities: [
        { id: crypto.randomUUID(), agentId, action, ok, message, card, ts },
        ...s.boardActivities,
      ].slice(0, 100),
    })),

  appendProcessActivity: (agentId, agentName, code, stderrTail) =>
    set((s) => ({
      processActivities: [
        {
          id: crypto.randomUUID(),
          agentId,
          agentName,
          code,
          stderrTail,
          ts: new Date().toISOString(),
        },
        ...s.processActivities,
      ].slice(0, 100),
    })),

  clearChatView: (agentId) =>
    set((s) => ({
      chatClearBefore: {
        ...s.chatClearBefore,
        [agentId]: new Date().toISOString(),
      },
    })),

  carryChatViewCutoff: (fromAgentId, toAgentId) =>
    set((s) => {
      const cutoff = s.chatClearBefore[fromAgentId];
      if (!cutoff) return {};
      return {
        chatClearBefore: {
          ...s.chatClearBefore,
          [toAgentId]: cutoff,
        },
      };
    }),

  clearActivityView: () => set({ activityClearBefore: new Date().toISOString() }),

  openEditorTab: (path, content, mtimeMs, targetGroupId) =>
    set((s) => {
      const groupId = targetGroupId ?? s.activeGroupId;
      const group = s.editorGroups[groupId];
      if (!group) return {};
      const existing = group.tabs.find((t) => t.path === path);
      const nextTabs = existing
        ? group.tabs
        : [
            ...group.tabs,
            { path, savedContent: content, mtimeMs, isDirty: false },
          ];
      return {
        editorGroups: {
          ...s.editorGroups,
          [groupId]: { ...group, tabs: nextTabs, activePath: path },
        },
        activeGroupId: groupId,
        editorVisible: true,
      };
    }),

  closeEditorTab: (groupId, path) =>
    set((s) => {
      const group = s.editorGroups[groupId];
      if (!group) return {};
      const idx = group.tabs.findIndex((t) => t.path === path);
      if (idx < 0) return {};
      const nextTabs = group.tabs.filter((t) => t.path !== path);
      let activePath = group.activePath;
      if (group.activePath === path) {
        const fallback = nextTabs[Math.min(idx, nextTabs.length - 1)] ?? null;
        activePath = fallback ? fallback.path : null;
      }
      // Empty group + not the only group → collapse it.
      if (nextTabs.length === 0 && countLeaves(s.editorLayout) > 1) {
        const layout = removeGroupFromLayout(s.editorLayout, groupId);
        const { [groupId]: _, ...restGroups } = s.editorGroups;
        const fallbackId = firstLeafId(layout) ?? "g0";
        return {
          editorGroups: restGroups,
          editorLayout: layout,
          activeGroupId:
            s.activeGroupId === groupId ? fallbackId : s.activeGroupId,
        };
      }
      const visible = anyTabsRemain(s.editorGroups, groupId, nextTabs.length)
        ? s.editorVisible
        : false;
      return {
        editorGroups: {
          ...s.editorGroups,
          [groupId]: { ...group, tabs: nextTabs, activePath },
        },
        editorVisible: visible,
      };
    }),

  reorderEditorTab: (groupId, path, targetPath, placeAfter) =>
    set((s) => {
      if (path === targetPath) return {};
      const group = s.editorGroups[groupId];
      if (!group) return {};
      const fromIndex = group.tabs.findIndex((t) => t.path === path);
      const targetIndex = group.tabs.findIndex((t) => t.path === targetPath);
      if (fromIndex < 0 || targetIndex < 0) return {};
      const tabs = [...group.tabs];
      const [tab] = tabs.splice(fromIndex, 1);
      let insertIndex = tabs.findIndex((t) => t.path === targetPath);
      if (insertIndex < 0) insertIndex = tabs.length;
      if (placeAfter) insertIndex += 1;
      tabs.splice(insertIndex, 0, tab);
      return {
        editorGroups: {
          ...s.editorGroups,
          [groupId]: { ...group, tabs, activePath: path },
        },
        activeGroupId: groupId,
      };
    }),

  setActiveEditorTab: (groupId, path) =>
    set((s) => {
      const group = s.editorGroups[groupId];
      if (!group) return {};
      return {
        editorGroups: {
          ...s.editorGroups,
          [groupId]: { ...group, activePath: path },
        },
        activeGroupId: groupId,
      };
    }),

  setActiveGroup: (groupId) =>
    set((s) =>
      s.editorGroups[groupId] ? { activeGroupId: groupId } : {},
    ),

  splitEditorGroup: (groupId, direction) =>
    set((s) => {
      const group = s.editorGroups[groupId];
      if (!group) return {};
      const newId = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      // The new sibling starts focused on the same active tab so the user can
      // immediately swap one side to a different file for comparison.
      const cloneTabs: EditorTab[] = group.tabs.map((t) => ({ ...t }));
      const layout = splitLeafInLayout(s.editorLayout, groupId, newId, direction);
      return {
        editorGroups: {
          ...s.editorGroups,
          [newId]: { id: newId, tabs: cloneTabs, activePath: group.activePath },
        },
        editorLayout: layout,
        activeGroupId: newId,
        editorVisible: true,
      };
    }),

  closeEditorGroup: (groupId) =>
    set((s) => {
      if (!s.editorGroups[groupId]) return {};
      if (countLeaves(s.editorLayout) <= 1) {
        // Last group standing — empty it instead of removing.
        return {
          editorGroups: {
            ...s.editorGroups,
            [groupId]: { id: groupId, tabs: [], activePath: null },
          },
          editorVisible: false,
        };
      }
      const layout = removeGroupFromLayout(s.editorLayout, groupId);
      const { [groupId]: _, ...rest } = s.editorGroups;
      const fallbackId = firstLeafId(layout) ?? "g0";
      return {
        editorGroups: rest,
        editorLayout: layout,
        activeGroupId:
          s.activeGroupId === groupId ? fallbackId : s.activeGroupId,
      };
    }),

  dropTabIntoGroup: (fromGroupId, path, targetGroupId, zone) =>
    set((s) => {
      const fromGroup = s.editorGroups[fromGroupId];
      const targetGroup = s.editorGroups[targetGroupId];
      if (!fromGroup || !targetGroup) return {};
      const tab = fromGroup.tabs.find((t) => t.path === path);
      if (!tab) return {};

      // Center drop = move tab into target group (or just refocus if same).
      if (zone === "center") {
        if (fromGroupId === targetGroupId) {
          return {
            editorGroups: {
              ...s.editorGroups,
              [targetGroupId]: { ...targetGroup, activePath: path },
            },
            activeGroupId: targetGroupId,
          };
        }
        const alreadyInTarget = targetGroup.tabs.some((t) => t.path === path);
        const targetTabs = alreadyInTarget
          ? targetGroup.tabs
          : [...targetGroup.tabs, { ...tab }];
        const fromTabs = fromGroup.tabs.filter((t) => t.path !== path);

        if (fromTabs.length === 0 && countLeaves(s.editorLayout) > 1) {
          const layout = removeGroupFromLayout(s.editorLayout, fromGroupId);
          const { [fromGroupId]: _, ...rest } = s.editorGroups;
          return {
            editorGroups: {
              ...rest,
              [targetGroupId]: { ...targetGroup, tabs: targetTabs, activePath: path },
            },
            editorLayout: layout,
            activeGroupId: targetGroupId,
          };
        }
        const fromActive =
          fromGroup.activePath === path
            ? fromTabs[0]?.path ?? null
            : fromGroup.activePath;
        return {
          editorGroups: {
            ...s.editorGroups,
            [fromGroupId]: { ...fromGroup, tabs: fromTabs, activePath: fromActive },
            [targetGroupId]: { ...targetGroup, tabs: targetTabs, activePath: path },
          },
          activeGroupId: targetGroupId,
        };
      }

      // Edge drop = split target with a new sibling, place tab there.
      const direction: SplitDirection =
        zone === "left" || zone === "right" ? "horizontal" : "vertical";
      const placeBefore = zone === "left" || zone === "top";
      const newId = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const layoutAfterSplit = splitLeafWithOrder(
        s.editorLayout,
        targetGroupId,
        newId,
        direction,
        placeBefore,
      );
      const newGroup: EditorGroup = {
        id: newId,
        tabs: [{ ...tab }],
        activePath: path,
      };
      const splittingWithinSameGroup = fromGroupId === targetGroupId;

      if (splittingWithinSameGroup) {
        return {
          editorGroups: {
            ...s.editorGroups,
            [newId]: newGroup,
          },
          editorLayout: layoutAfterSplit,
          activeGroupId: newId,
        };
      }

      const fromTabs = fromGroup.tabs.filter((t) => t.path !== path);
      const sourceEmptied = fromTabs.length === 0;

      if (sourceEmptied && countLeaves(layoutAfterSplit) > 1) {
        const layoutFinal = removeGroupFromLayout(layoutAfterSplit, fromGroupId);
        const { [fromGroupId]: _, ...rest } = s.editorGroups;
        return {
          editorGroups: { ...rest, [newId]: newGroup },
          editorLayout: layoutFinal,
          activeGroupId: newId,
        };
      }
      const fromActive =
        fromGroup.activePath === path
          ? fromTabs[0]?.path ?? null
          : fromGroup.activePath;
      return {
        editorGroups: {
          ...s.editorGroups,
          [fromGroupId]: { ...fromGroup, tabs: fromTabs, activePath: fromActive },
          [newId]: newGroup,
        },
        editorLayout: layoutAfterSplit,
        activeGroupId: newId,
      };
    }),

  openEditorDrop: (path, content, mtimeMs, targetGroupId, zone) =>
    set((s) => {
      const targetGroup = s.editorGroups[targetGroupId];
      if (!targetGroup) return {};

      if (zone === "center") {
        const existing = targetGroup.tabs.find((t) => t.path === path);
        const tabs = existing
          ? targetGroup.tabs
          : [...targetGroup.tabs, { path, savedContent: content, mtimeMs, isDirty: false }];
        return {
          editorGroups: {
            ...s.editorGroups,
            [targetGroupId]: { ...targetGroup, tabs, activePath: path },
          },
          activeGroupId: targetGroupId,
          editorVisible: true,
        };
      }

      const direction: SplitDirection =
        zone === "left" || zone === "right" ? "horizontal" : "vertical";
      const placeBefore = zone === "left" || zone === "top";
      const newId = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const layout = splitLeafWithOrder(
        s.editorLayout,
        targetGroupId,
        newId,
        direction,
        placeBefore,
      );
      return {
        editorGroups: {
          ...s.editorGroups,
          [newId]: {
            id: newId,
            tabs: [{ path, savedContent: content, mtimeMs, isDirty: false }],
            activePath: path,
          },
        },
        editorLayout: layout,
        activeGroupId: newId,
        editorVisible: true,
      };
    }),

  resizeEditorSplit: (path, sizes) =>
    set((s) => ({
      editorLayout: setSizesAtPath(s.editorLayout, path, sizes),
    })),

  setEditorVisible: (visible) => set({ editorVisible: visible }),
  setDraggingEditorTab: (dragging) => set({ isDraggingEditorTab: dragging }),
  setDraggingEditorFile: (dragging, path) =>
    set({
      isDraggingEditorFile: dragging,
      draggingEditorFilePath: dragging ? (path ?? null) : null,
    }),

  markEditorDirty: (groupId, path, isDirty) =>
    set((s) => {
      const group = s.editorGroups[groupId];
      if (!group) return {};
      return {
        editorGroups: {
          ...s.editorGroups,
          [groupId]: {
            ...group,
            tabs: group.tabs.map((t) =>
              t.path === path ? { ...t, isDirty } : t,
            ),
          },
        },
      };
    }),

  recordEditorSave: (groupId, path, savedContent, mtimeMs) =>
    set((s) => {
      const group = s.editorGroups[groupId];
      if (!group) return {};
      return {
        editorGroups: {
          ...s.editorGroups,
          [groupId]: {
            ...group,
            tabs: group.tabs.map((t) =>
              t.path === path ? { ...t, savedContent, mtimeMs, isDirty: false } : t,
            ),
          },
        },
      };
    }),
}));

// ---------- Layout helpers ----------

function countLeaves(layout: EditorLayout): number {
  if (layout.kind === "leaf") return 1;
  return layout.children.reduce((acc, c) => acc + countLeaves(c), 0);
}

function firstLeafId(layout: EditorLayout): string | null {
  if (layout.kind === "leaf") return layout.groupId;
  for (const child of layout.children) {
    const id = firstLeafId(child);
    if (id) return id;
  }
  return null;
}

function splitLeafInLayout(
  layout: EditorLayout,
  targetId: string,
  newId: string,
  direction: SplitDirection,
): EditorLayout {
  return splitLeafWithOrder(layout, targetId, newId, direction, false);
}

function splitLeafWithOrder(
  layout: EditorLayout,
  targetId: string,
  newId: string,
  direction: SplitDirection,
  placeBefore: boolean,
): EditorLayout {
  if (layout.kind === "leaf") {
    if (layout.groupId !== targetId) return layout;
    const children: EditorLayout[] = placeBefore
      ? [
          { kind: "leaf", groupId: newId },
          { kind: "leaf", groupId: targetId },
        ]
      : [
          { kind: "leaf", groupId: targetId },
          { kind: "leaf", groupId: newId },
        ];
    return {
      kind: "split",
      direction,
      children,
      sizes: [50, 50],
    };
  }
  let changed = false;
  const children = layout.children.map((c) => {
    const next = splitLeafWithOrder(c, targetId, newId, direction, placeBefore);
    if (next !== c) changed = true;
    return next;
  });
  if (!changed) return layout;
  return { ...layout, children };
}

function removeGroupFromLayout(
  layout: EditorLayout,
  groupId: string,
): EditorLayout {
  if (layout.kind === "leaf") return layout;
  const filtered = layout.children
    .map((c) => removeGroupFromLayout(c, groupId))
    .filter((c) => !(c.kind === "leaf" && c.groupId === groupId));
  if (filtered.length === 0) {
    // Collapsed branch — caller should have prevented this, but stay safe.
    return layout.children[0];
  }
  if (filtered.length === 1) return filtered[0];
  // Renormalize sizes to sum to 100 across the surviving children.
  const each = 100 / filtered.length;
  return {
    ...layout,
    children: filtered,
    sizes: filtered.map(() => each),
  };
}

function setSizesAtPath(
  layout: EditorLayout,
  path: number[],
  sizes: number[],
): EditorLayout {
  if (path.length === 0) {
    if (layout.kind !== "split") return layout;
    return { ...layout, sizes };
  }
  if (layout.kind !== "split") return layout;
  const [head, ...rest] = path;
  const children = layout.children.map((c, i) =>
    i === head ? setSizesAtPath(c, rest, sizes) : c,
  );
  return { ...layout, children };
}

function anyTabsRemain(
  groups: Record<string, EditorGroup>,
  changedGroupId: string,
  newCountForChanged: number,
): boolean {
  if (newCountForChanged > 0) return true;
  for (const [id, g] of Object.entries(groups)) {
    if (id === changedGroupId) continue;
    if (g.tabs.length > 0) return true;
  }
  return false;
}
