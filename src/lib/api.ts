import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  AgentSnapshot,
  AgentSpec,
  BitbucketPrInfo,
  Board,
  BoardCard,
  BoardColumn,
  CardInput,
  CcusageReport,
  CustomPreset,
  ExternalSession,
  FileContent,
  FsEntry,
  GitBranch,
  GitChanges,
  GitCommit,
  GitStash,
  GitStatus,
  HistoryAgent,
  HistoryMessage,
  ImageAttachment,
  Mission,
  PtySnapshot,
  RuntimeDiagnostics,
  SkillEntry,
  SkillKind,
  SkillScope,
  UsageStats,
  VendorInfo,
  Workspace,
  WorkspaceTool,
} from "../types";

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const hasTauriBackend =
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    typeof (window as any).__TAURI_INTERNALS__?.invoke === "function";

  if (!hasTauriBackend) {
    return Promise.reject(
      new Error(
        "Tauri backend is not available. Open the app with `npm.cmd run tauri dev` or the desktop build; backend actions such as spawning agents do not work in a plain browser tab.",
      ),
    );
  }

  return tauriInvoke<T>(command, args);
}

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
    workspaceId?: string | null;
    program?: string;
    args?: string[];
    cols?: number;
    rows?: number;
  }) =>
    invoke<PtySnapshot>("pty_spawn", {
      spec: {
        title: spec.title,
        cwd: spec.cwd,
        workspaceId: spec.workspaceId ?? null,
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
  deleteExternalSession: (jsonlPath: string) =>
    invoke<void>("delete_external_session", { jsonlPath }),
  listVendors: () => invoke<VendorInfo[]>("list_available_vendors"),
  runtimeDiagnostics: () => invoke<RuntimeDiagnostics>("runtime_diagnostics"),
  homeDir: () => invoke<string | null>("home_dir"),
  workspaceDir: () => invoke<string>("workspace_dir"),
  workspacesBootstrap: (rootPath: string) =>
    invoke<Workspace>("workspaces_bootstrap", { rootPath }),
  workspacesList: () => invoke<Workspace[]>("workspaces_list"),
  workspacesTouch: (id: string) => invoke<void>("workspaces_touch", { id }),
  workspacesRemove: (id: string) => invoke<void>("workspaces_remove", { id }),
  pickWorkspaceFolder: (initialPath?: string | null) =>
    invoke<string | null>("pick_workspace_folder", { initialPath: initialPath ?? null }),
  missionsList: (workspaceId: string) =>
    invoke<Mission[]>("missions_list", { workspaceId }),
  missionsSave: (payload: {
    workspaceId: string;
    id?: string | null;
    title: string;
    goal: string;
    definitionOfDone?: string | null;
    constraints?: string | null;
    setActive: boolean;
  }) =>
    invoke<Mission>("missions_save", {
      payload: {
        workspaceId: payload.workspaceId,
        id: payload.id ?? null,
        title: payload.title,
        goal: payload.goal,
        definitionOfDone: payload.definitionOfDone ?? null,
        constraints: payload.constraints ?? null,
        setActive: payload.setActive,
      },
    }),
  missionsSetActive: (workspaceId: string, missionId: string | null) =>
    invoke<void>("missions_set_active", { workspaceId, missionId }),
  workspaceTools: () => invoke<WorkspaceTool[]>("workspace_tools"),
  workspaceOpenTool: (toolId: string, cwd: string) =>
    invoke<void>("workspace_open_tool", { toolId, cwd }),
  openPathExternal: (path: string) => invoke<void>("open_path_external", { path }),
  fsListDir: (path: string) => invoke<FsEntry[]>("fs_list_dir", { path }),
  fsReadFile: (path: string) => invoke<FileContent>("fs_read_file", { path }),
  fsWriteFile: (path: string, content: string) =>
    invoke<number>("fs_write_file", { path, content }),
  fsCreateFile: (path: string) => invoke<string>("fs_create_file", { path }),
  fsCreateDir: (path: string) => invoke<string>("fs_create_dir", { path }),
  fsRename: (from: string, to: string) =>
    invoke<string>("fs_rename", { from, to }),
  fsDelete: (path: string) => invoke<void>("fs_delete", { path }),
  savePastedImage: (payload: {
    cwd: string;
    dataB64: string;
    mime: string;
    name?: string | null;
  }) => invoke<ImageAttachment>("save_pasted_image", { payload }),
  gitStatus: (cwd: string) => invoke<GitStatus>("git_status", { cwd }),

  // Source Control
  gitChanges: (cwd: string) => invoke<GitChanges>("git_changes", { cwd }),
  gitDiff: (
    cwd: string,
    payload: { path: string; staged?: boolean; untracked?: boolean },
  ) =>
    invoke<string>("git_diff", {
      cwd,
      payload: {
        path: payload.path,
        staged: payload.staged ?? false,
        untracked: payload.untracked ?? false,
      },
    }),
  gitStage: (cwd: string, paths: string[]) =>
    invoke<void>("git_stage", { cwd, paths }),
  gitStageAll: (cwd: string) => invoke<void>("git_stage_all", { cwd }),
  gitUnstage: (cwd: string, paths: string[]) =>
    invoke<void>("git_unstage", { cwd, paths }),
  gitUnstageAll: (cwd: string) => invoke<void>("git_unstage_all", { cwd }),
  gitDiscard: (cwd: string, paths: string[], untracked: boolean) =>
    invoke<void>("git_discard", { cwd, paths, untracked }),
  gitCommit: (
    cwd: string,
    payload: { message: string; amend?: boolean; signOff?: boolean },
  ) =>
    invoke<string>("git_commit", {
      cwd,
      payload: {
        message: payload.message,
        amend: payload.amend ?? false,
        signOff: payload.signOff ?? false,
      },
    }),
  gitPush: (cwd: string, setUpstream: boolean) =>
    invoke<string>("git_push", { cwd, setUpstream }),
  gitPull: (cwd: string) => invoke<string>("git_pull", { cwd }),
  gitFetch: (cwd: string) => invoke<string>("git_fetch", { cwd }),
  gitBranches: (cwd: string) => invoke<GitBranch[]>("git_branches", { cwd }),
  gitCheckout: (cwd: string, branch: string, create: boolean) =>
    invoke<void>("git_checkout", { cwd, branch, create }),
  gitLog: (cwd: string, limit?: number) =>
    invoke<GitCommit[]>("git_log", { cwd, limit: limit ?? null }),
  gitStashList: (cwd: string) => invoke<GitStash[]>("git_stash_list", { cwd }),
  gitStashSave: (cwd: string, message: string, includeUntracked: boolean) =>
    invoke<void>("git_stash_save", { cwd, message, includeUntracked }),
  gitStashPop: (cwd: string, index: number) =>
    invoke<void>("git_stash_pop", { cwd, index }),
  gitStashDrop: (cwd: string, index: number) =>
    invoke<void>("git_stash_drop", { cwd, index }),

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
  proposalDecisionRecord: (payload: {
    key: string;
    agentId: string;
    messageId: string;
    proposalIndex: number;
    body: string;
    decision: "approved" | "denied";
    reason?: string | null;
  }) =>
    invoke<void>("proposal_decision_record", {
      payload: {
        key: payload.key,
        agentId: payload.agentId,
        messageId: payload.messageId,
        proposalIndex: payload.proposalIndex,
        body: payload.body,
        decision: payload.decision,
        reason: payload.reason ?? null,
      },
    }),
  bitbucketPrFetch: (url: string) =>
    invoke<BitbucketPrInfo>("bitbucket_pr_fetch", { url }),
  bitbucketPrApprove: (url: string) =>
    invoke<void>("bitbucket_pr_approve", { url }),

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
  boardsList: (workspaceId?: string | null) =>
    invoke<Board[]>("boards_list", { workspaceId: workspaceId ?? null }),
  boardsCreate: (name: string, description?: string | null, workspaceId?: string | null) =>
    invoke<Board>("boards_create", {
      workspaceId: workspaceId ?? null,
      name,
      description: description ?? null,
    }),
  boardsUpdate: (id: number, name: string, description?: string | null) =>
    invoke<Board>("boards_update", { id, name, description: description ?? null }),
  boardsDelete: (id: number) => invoke<void>("boards_delete", { id }),

  columnsList: (boardId: number) =>
    invoke<BoardColumn[]>("columns_list", { boardId }),
  columnsCreate: (boardId: number, title: string, color?: string | null) =>
    invoke<BoardColumn>("columns_create", {
      boardId, title, color: color ?? null,
    }),
  columnsUpdate: (
    id: number,
    title: string,
    color?: string | null,
    description?: string | null,
    entryCriteria?: string | null,
    exitCriteria?: string | null,
    allowedNextColumnIds?: number[],
  ) =>
    invoke<BoardColumn>("columns_update", {
      id,
      title,
      color: color ?? null,
      description: description ?? null,
      entryCriteria: entryCriteria ?? null,
      exitCriteria: exitCriteria ?? null,
      allowedNextColumnIds: allowedNextColumnIds ?? [],
    }),
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
