import type { Workspace, WorkspaceContext } from "../types";

export function workspaceNameFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized || "Workspace";
}

export function workspaceFromPath(path: string): WorkspaceContext {
  return {
    id: `path:${normalizePath(path)}`,
    name: workspaceNameFromPath(path),
    root: path,
  };
}

export function workspaceContextFromWorkspace(workspace: Workspace): WorkspaceContext {
  return {
    id: workspace.id,
    name: workspace.name,
    root: workspace.root_path,
    active_mission_id: workspace.active_mission_id,
  };
}

export function shortPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `.../${parts.slice(-3).join("/")}`;
}

export function isInsideWorkspace(path: string, workspaceRoot: string): boolean {
  const a = normalizePath(path);
  const b = normalizePath(workspaceRoot);
  return a === b || a.startsWith(`${b}/`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
