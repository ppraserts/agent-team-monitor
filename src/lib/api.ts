import { invoke } from "@tauri-apps/api/core";
import type {
  AgentSnapshot,
  AgentSpec,
  CustomPreset,
  ExternalSession,
  HistoryAgent,
  HistoryMessage,
  PtySnapshot,
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
};
