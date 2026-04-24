import { invoke } from "@tauri-apps/api/core";
import type {
  AgentSnapshot,
  AgentSpec,
  Board,
  BoardCard,
  BoardColumn,
  CardInput,
  CcusageReport,
  CustomPreset,
  ExternalSession,
  HistoryAgent,
  HistoryMessage,
  PtySnapshot,
  SkillEntry,
  SkillKind,
  SkillScope,
  UsageStats,
  VendorInfo,
} from "../types";

export const api = {
  spawnAgent: (spec: AgentSpec) =>
    invoke<AgentSnapshot>("agent_spawn", { spec }),
  resumeAgent: (spec: AgentSpec, sessionId: string | null) =>
    invoke<AgentSnapshot>("agent_resume", { spec, sessionId }),
  sendAgent: (agentId: string, message: string) =>
    invoke<void>("agent_send", { agentId, message }),
  killAgent: (agentId: string) => invoke<void>("agent_kill", { agentId }),
  listAgents: () => invoke<AgentSnapshot[]>("agent_list"),

  spawnPty: (spec: {
    title: string;
    cwd: string;
    program?: string;
    args?: string[];
    cols?: number;
    rows?: number;
  }) =>
    invoke<PtySnapshot>("pty_spawn", {
      spec: {
        title: spec.title,
        cwd: spec.cwd,
        program: spec.program ?? null,
        args: spec.args ?? [],
        cols: spec.cols ?? 120,
        rows: spec.rows ?? 32,
      },
    }),
  writePty: (ptyId: string, data: Uint8Array) => {
    let bin = "";
    for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
    return invoke<void>("pty_write", { ptyId, dataB64: btoa(bin) });
  },
  resizePty: (ptyId: string, cols: number, rows: number) =>
    invoke<void>("pty_resize", { ptyId, cols, rows }),
  killPty: (ptyId: string) => invoke<void>("pty_kill", { ptyId }),
  listPtys: () => invoke<PtySnapshot[]>("pty_list"),

  listExternalSessions: () =>
    invoke<ExternalSession[]>("list_external_sessions"),
  listVendors: () => invoke<VendorInfo[]>("list_available_vendors"),
  homeDir: () => invoke<string | null>("home_dir"),

  // History / persistence
  historyListAgents: (limit?: number) =>
    invoke<HistoryAgent[]>("history_list_agents", { limit: limit ?? null }),
  historyLoadMessages: (agentId: string) =>
    invoke<HistoryMessage[]>("history_load_messages", { agentId }),
  historyDeleteAgent: (agentId: string) =>
    invoke<void>("history_delete_agent", { agentId }),
  usageStats: () => invoke<UsageStats>("usage_stats"),

  // Settings
  settingsGetAll: () => invoke<Record<string, string>>("settings_get_all"),
  settingsSet: (key: string, value: string) =>
    invoke<void>("settings_set", { key, value }),

  // Custom presets
  presetsList: () => invoke<CustomPreset[]>("presets_list"),
  presetsSave: (preset: CustomPreset) => invoke<void>("presets_save", { preset }),
  presetsDelete: (name: string) => invoke<void>("presets_delete", { name }),

  // Destructive
  dataClearAll: () => invoke<void>("data_clear_all"),
  dataPath: () => invoke<string>("data_path"),

  // ccusage — global Claude usage from ~/.claude/projects/*.jsonl
  ccusageReport: () => invoke<CcusageReport>("ccusage_report"),

  // Skills + slash commands
  skillsList: (cwd: string) => invoke<SkillEntry[]>("skills_list", { cwd }),
  skillsSave: (
    cwd: string,
    kind: SkillKind,
    scope: SkillScope,
    name: string,
    body: string,
  ) =>
    invoke<SkillEntry>("skills_save", {
      payload: { cwd, kind, scope, name, body },
    }),
  skillsDelete: (path: string) => invoke<void>("skills_delete", { path }),
  skillsDefaultBody: (kind: SkillKind, name: string) =>
    invoke<string>("skills_default_body", { kind, name }),

  // Boards (Trello-style task boards)
  boardsList: () => invoke<Board[]>("boards_list"),
  boardsCreate: (name: string, description?: string | null) =>
    invoke<Board>("boards_create", { name, description: description ?? null }),
  boardsUpdate: (id: number, name: string, description?: string | null) =>
    invoke<Board>("boards_update", { id, name, description: description ?? null }),
  boardsDelete: (id: number) => invoke<void>("boards_delete", { id }),

  columnsList: (boardId: number) =>
    invoke<BoardColumn[]>("columns_list", { boardId }),
  columnsCreate: (boardId: number, title: string, color?: string | null) =>
    invoke<BoardColumn>("columns_create", {
      boardId, title, color: color ?? null,
    }),
  columnsUpdate: (id: number, title: string, color?: string | null) =>
    invoke<BoardColumn>("columns_update", { id, title, color: color ?? null }),
  columnsDelete: (id: number) => invoke<void>("columns_delete", { id }),
  columnsReorder: (boardId: number, orderedIds: number[]) =>
    invoke<void>("columns_reorder", { boardId, orderedIds }),

  cardsList: (boardId: number) =>
    invoke<BoardCard[]>("cards_list", { boardId }),
  cardsCreate: (columnId: number, input: CardInput) =>
    invoke<BoardCard>("cards_create", { columnId, input }),
  cardsUpdate: (id: number, input: CardInput) =>
    invoke<BoardCard>("cards_update", { id, input }),
  cardsDelete: (id: number) => invoke<void>("cards_delete", { id }),
  cardsMove: (cardId: number, newColumnId: number, newPosition: number) =>
    invoke<BoardCard>("cards_move", {
      cardId, newColumnId, newPosition,
    }),
};
