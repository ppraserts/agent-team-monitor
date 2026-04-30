import { create } from "zustand";
import type {
  AgentSnapshot,
  AgentStatus,
  AgentUsage,
  ChatMessage,
  PtySnapshot,
  VendorInfo,
  BoardCard,
} from "./types";

interface AgentRecord {
  snapshot: AgentSnapshot;
  messages: ChatMessage[];
}

interface State {
  agents: Record<string, AgentRecord>;
  ptys: Record<string, PtySnapshot>;
  vendors: VendorInfo[];
  homeDir: string | null;

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

  // selectors / mutations
  setVendors: (v: VendorInfo[]) => void;
  setHomeDir: (h: string | null) => void;
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
}

export const useStore = create<State>((set) => ({
  agents: {},
  ptys: {},
  vendors: [],
  homeDir: null,
  activeTileId: null,
  layout: [],
  proposalDecisions: {},
  agentCardLink: {},
  boardRevision: 0,
  boardActivities: [],
  processActivities: [],

  setVendors: (v) => set({ vendors: v }),
  setHomeDir: (h) => set({ homeDir: h }),

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
}));
