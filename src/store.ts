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

interface State {
  agents: Record<string, AgentRecord>;
  ptys: Record<string, PtySnapshot>;
  vendors: VendorInfo[];
  homeDir: string | null;
  workspaces: Workspace[];
  missions: Mission[];
  activeWorkspace: WorkspaceContext | null;

  editorTabs: EditorTab[];
  activeEditorPath: string | null;
  editorVisible: boolean;

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

  openEditorTab: (path: string, content: string, mtimeMs: number) => void;
  closeEditorTab: (path: string) => void;
  setActiveEditorPath: (path: string | null) => void;
  setEditorVisible: (visible: boolean) => void;
  markEditorDirty: (path: string, isDirty: boolean) => void;
  recordEditorSave: (path: string, savedContent: string, mtimeMs: number) => void;
}

export const useStore = create<State>((set) => ({
  agents: {},
  ptys: {},
  vendors: [],
  homeDir: null,
  workspaces: [],
  missions: [],
  activeWorkspace: null,
  editorTabs: [],
  activeEditorPath: null,
  editorVisible: false,
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
    set((s) => ({
      layout: s.layout.includes(id) ? s.layout.filter((x) => x !== id) : [...s.layout, id],
    })),
  removeFromLayout: (id) =>
    set((s) => ({ layout: s.layout.filter((x) => x !== id) })),

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

  openEditorTab: (path, content, mtimeMs) =>
    set((s) => {
      const existingIdx = s.editorTabs.findIndex((t) => t.path === path);
      if (existingIdx >= 0) {
        // Already open — just focus it. Don't clobber unsaved edits.
        return { activeEditorPath: path, editorVisible: true };
      }
      return {
        editorTabs: [
          ...s.editorTabs,
          { path, savedContent: content, mtimeMs, isDirty: false },
        ],
        activeEditorPath: path,
        editorVisible: true,
      };
    }),

  closeEditorTab: (path) =>
    set((s) => {
      const idx = s.editorTabs.findIndex((t) => t.path === path);
      if (idx < 0) return {};
      const nextTabs = s.editorTabs.filter((t) => t.path !== path);
      let activeEditorPath = s.activeEditorPath;
      if (s.activeEditorPath === path) {
        const fallback = nextTabs[Math.min(idx, nextTabs.length - 1)] ?? null;
        activeEditorPath = fallback ? fallback.path : null;
      }
      return {
        editorTabs: nextTabs,
        activeEditorPath,
        editorVisible: nextTabs.length > 0 ? s.editorVisible : false,
      };
    }),

  setActiveEditorPath: (path) => set({ activeEditorPath: path }),
  setEditorVisible: (visible) => set({ editorVisible: visible }),

  markEditorDirty: (path, isDirty) =>
    set((s) => ({
      editorTabs: s.editorTabs.map((t) =>
        t.path === path ? { ...t, isDirty } : t,
      ),
    })),

  recordEditorSave: (path, savedContent, mtimeMs) =>
    set((s) => ({
      editorTabs: s.editorTabs.map((t) =>
        t.path === path ? { ...t, savedContent, mtimeMs, isDirty: false } : t,
      ),
    })),
}));
