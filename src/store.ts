import { create } from "zustand";
import type {
  AgentSnapshot,
  AgentStatus,
  AgentUsage,
  ChatMessage,
  PtySnapshot,
  VendorInfo,
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
}

export const useStore = create<State>((set) => ({
  agents: {},
  ptys: {},
  vendors: [],
  homeDir: null,
  activeTileId: null,
  layout: [],
  proposalDecisions: {},

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
}));
