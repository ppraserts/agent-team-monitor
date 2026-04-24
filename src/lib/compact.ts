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
import type { AgentSnapshot, ChatMessage } from "../types";

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

  // 3. Kill the old process. Best-effort — even if this fails the new spawn
  // will still proceed (different ID, no name collision because we remove
  // from registry below).
  try {
    await api.killAgent(agentId);
  } catch (e) {
    console.warn("kill during compact failed (continuing):", e);
  }

  // Wait briefly for backend to drop the agent from the name index, otherwise
  // the spawn will reject "name already exists".
  await waitForAgentRemoved(oldSpec.name, 5_000);

  // 4. Spawn fresh with same spec + summary appended to system prompt.
  const newSystemPrompt =
    (oldSpec.system_prompt ?? "").trimEnd() +
    "\n\n--- COMPACTED PRIOR CONTEXT (auto-summary, fresh session continues from here) ---\n" +
    summary;

  const newSnap = await api.spawnAgent({
    ...oldSpec,
    system_prompt: newSystemPrompt,
  });

  // The backend's `created` event will upsert the new agent into the store.
  // Wait a tick so the listener has run, then carry old messages over and
  // append the divider.
  await new Promise((r) => setTimeout(r, 50));

  const s = useStore.getState();
  // Replay messages: keep the user's visible history under the NEW id.
  const target = newSnap.id;
  for (const m of oldMessages) {
    s.appendMessage(target, { ...m, id: crypto.randomUUID() });
  }
  s.appendMessage(target, {
    id: crypto.randomUUID(),
    role: "system" as any,
    content: `[local] --- COMPACTED at ${new Date().toLocaleTimeString()} — context reset to ~${summary.length} chars summary. The agent remembers via system prompt; the panel above is your visual history. ---`,
    ts: new Date().toISOString(),
  });
  s.setActive(target);

  return {
    newAgent: newSnap,
    summary,
    carriedMessages: oldMessages.length,
  };
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
