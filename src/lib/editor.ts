import { api } from "./api";
import { useStore } from "../store";
import type { EditorDropZone } from "../store";

export const EDITOR_FILE_MIME = "application/x-monitor-editor-file";

// Open a file in the editor pane. Reads via Tauri, refuses binary files,
// and surfaces failures to the caller as a thrown error.
export async function openFileInEditor(path: string, targetGroupId?: string): Promise<void> {
  const file = await api.fsReadFile(path);
  assertTextFile(file.path, file.is_binary);
  useStore.getState().openEditorTab(file.path, file.content, file.mtime_ms, targetGroupId);
}

export async function openFileInEditorDrop(
  path: string,
  targetGroupId: string,
  zone: EditorDropZone,
): Promise<void> {
  const file = await api.fsReadFile(path);
  assertTextFile(file.path, file.is_binary);
  useStore.getState().openEditorDrop(file.path, file.content, file.mtime_ms, targetGroupId, zone);
}

function assertTextFile(path: string, isBinary: boolean) {
  if (isBinary) {
    throw new Error(`${path} is binary - refusing to open in the text editor.`);
  }
}
