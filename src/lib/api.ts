import { invoke } from "@tauri-apps/api/core";
import type {
  AgentSnapshot,
  AgentSpec,
  ExternalSession,
  PtySnapshot,
  VendorInfo,
} from "../types";

export const api = {
  spawnAgent: (spec: AgentSpec) =>
    invoke<AgentSnapshot>("agent_spawn", { spec }),
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
};
