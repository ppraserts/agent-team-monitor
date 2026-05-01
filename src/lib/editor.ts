import { api } from "./api";
import { useStore } from "../store";

/// Open a file in the editor pane. Reads via Tauri, refuses binary files,
/// and surfaces failures to the caller as a thrown error.
export async function openFileInEditor(path: string): Promise<void> {
  const file = await api.fsReadFile(path);
  if (file.is_binary) {
    throw new Error(`${file.path} is binary — refusing to open in the text editor.`);
  }
  useStore.getState().openEditorTab(file.path, file.content, file.mtime_ms);
}
