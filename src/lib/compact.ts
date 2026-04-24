// Manual / auto compaction for an agent.
//
// Strategy:
//   1. Send the agent a "summarize the conversation in <=400 words" message.
//   2. Wait for its next assistant reply — that is our summary.
//   3. Kill the underlying process (drops the entire context window).
//   4. Spawn a NEW agent with the same spec, but with the summary appended
//      to its system_prompt so it remembers what was discussed.
//   5. Replay the visible chat history into the new agent's UI panel and
//      add a divider message marking the compaction point.
//
// Net effect: the agent's effective context resets from ~190k → ~500 tokens,
// while the user keeps seeing the full conversation history in the panel.

import { api } from "./api";
import { useStore } from "../store";
import type { AgentSnapshot, AgentSpec, ChatMessage } from "../types";

const SUMMARY_PROMPT =
  "Please produce a TIGHT summary of our entire conversation so far in <= 400 words. " +
  "Include: (1) the original user goal, (2) key decisions made, (3) what has been done, " +
  "(4) what is still pending or open, (5) any important constraints, names, paths, or " +
  "facts I might need. Format as plain prose, no headers. " +
  "I will use this summary to continue our conversation in a fresh session.";

export interface CompactResult {
  newAgent: AgentSnapshot;
  summary: string;
  carriedMessages: number;
}

export async function compactAgent(agentId: string): Promise<CompactResult> {
  const store = useStore.getState();
  const record = store.agents[agentId];
  if (!record) throw new Error(`agent ${agentId} not found`);
  const oldSpec = record.snapshot.spec;
  const oldMessages: ChatMessage[] = [...record.messages];

  // Surface "compacting" status to UI.
  pushLocal(agentId, "[compacting] Asking the agent to summarize itself…");

  // 1. Send summary prompt.
  const beforeLen = oldMessages.length;
  await api.sendAgent(agentId, SUMMARY_PROMPT);

  // 2. Wait for the next assistant message via store subscription.
  const summary = await waitForNextAssistant(agentId, beforeLen, 180_000);

  pushLocal(agentId, "[compacting] Got summary, killing old process…");

  // 3+4+5. Reuse the shared respawn helper.
  const newSystemPrompt =
    (oldSpec.system_prompt ?? "").trimEnd() +
    "\n\n--- COMPACTED PRIOR CONTEXT (auto-summary, fresh session continues from here) ---\n" +
    summary;

  const newSnap = await respawnAgent(
    agentId,
    { ...oldSpec, system_prompt: newSystemPrompt },
    `--- COMPACTED at ${new Date().toLocaleTimeString()} — context reset to ~${summary.length} chars summary. The agent remembers via system prompt; the panel above is your visual history. ---`,
  );

  return {
    newAgent: newSnap,
    summary,
    carriedMessages: oldMessages.length,
  };
}

/// Replace an agent's running process with a fresh one using a new spec.
/// Used by:
///   - compactAgent (with summary appended to system_prompt)
///   - the AgentSettingsDialog (when the user edits prompt/toggles/etc.)
/// Captures + replays the visible chat history, adds a system divider so the
/// user can see where the cut happened, and switches the active tile to the
/// new id.
export async function respawnAgent(
  oldId: string,
  newSpec: AgentSpec,
  dividerMessage: string,
): Promise<AgentSnapshot> {
  const store = useStore.getState();
  const record = store.agents[oldId];
  if (!record) throw new Error(`agent ${oldId} not found`);

  const oldMessages: ChatMessage[] = [...record.messages];
  const oldName = record.snapshot.spec.name;

  // Best-effort kill; spawn will retry-by-name once the registry clears.
  try {
    await api.killAgent(oldId);
  } catch (e) {
    console.warn("kill during respawn failed (continuing):", e);
  }
  await waitForAgentRemoved(oldName, 5_000);

  const newSnap = await api.spawnAgent(newSpec);
  // The backend's `created` event will upsert the new agent into the store.
  await new Promise((r) => setTimeout(r, 50));

  const s = useStore.getState();
  for (const m of oldMessages) {
    s.appendMessage(newSnap.id, { ...m, id: crypto.randomUUID() });
  }
  s.appendMessage(newSnap.id, {
    id: crypto.randomUUID(),
    role: "system" as any,
    content: `[local] ${dividerMessage}`,
    ts: new Date().toISOString(),
  });
  s.setActive(newSnap.id);
  return newSnap;
}

/// Restart an agent with a (potentially mutated) spec. No summary, no
/// destructive operations — just a clean kill+spawn so changes to
/// system_prompt / toggles / model take effect.
export async function restartAgent(
  oldId: string,
  newSpec: AgentSpec,
): Promise<AgentSnapshot> {
  return respawnAgent(
    oldId,
    newSpec,
    `--- RESTARTED at ${new Date().toLocaleTimeString()} — agent re-spawned with updated settings. Past messages above are visible history; the agent itself only sees its new system prompt. ---`,
  );
}

function pushLocal(agentId: string, msg: string) {
  useStore.getState().appendMessage(agentId, {
    id: crypto.randomUUID(),
    role: "system" as any,
    content: `[local] ${msg}`,
    ts: new Date().toISOString(),
  });
}

function waitForNextAssistant(
  agentId: string,
  beforeLen: number,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => {
      unsub();
      reject(new Error("Timed out waiting for the agent's summary."));
    }, timeoutMs);
    const unsub = useStore.subscribe((state) => {
      const r = state.agents[agentId];
      if (!r) {
        clearTimeout(t);
        unsub();
        reject(new Error("Agent disappeared while waiting for summary."));
        return;
      }
      // Look at NEW messages added after we sent the prompt.
      for (let i = beforeLen; i < r.messages.length; i++) {
        const m = r.messages[i];
        if (m.role === "assistant" && m.content.trim().length > 0) {
          clearTimeout(t);
          unsub();
          resolve(m.content);
          return;
        }
      }
    });
  });
}

function waitForAgentRemoved(name: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const exists = Object.values(useStore.getState().agents).some(
        (a) => a.snapshot.spec.name === name,
      );
      if (!exists) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        // Give up waiting; spawn might still succeed if the kill propagates by then.
        resolve();
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}
