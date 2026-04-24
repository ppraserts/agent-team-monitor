import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LayoutGrid, Network, Eye, Zap } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { SpawnDialog } from "./components/SpawnDialog";
import { SettingsDialog, applyTheme } from "./components/SettingsDialog";
import { TeamFeed } from "./components/TeamFeed";
import { AgentGraph } from "./components/AgentGraph";
import { UsagePanel } from "./components/UsagePanel";
import { useStore } from "./store";
import { api } from "./lib/api";
import type { AgentEvent, HistoryAgent } from "./types";
import { cn } from "./lib/cn";

type RightPaneMode = "feed" | "graph" | "usage" | "off";

export default function App() {
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rightPane, setRightPane] = useState<RightPaneMode>("feed");
  const [mentionPulse, setMentionPulse] = useState<{ from: string; to: string; key: number } | null>(
    null,
  );

  const upsertAgent = useStore((s) => s.upsertAgent);
  const setStatus = useStore((s) => s.setStatus);
  const appendMessage = useStore((s) => s.appendMessage);
  const appendToolUse = useStore((s) => s.appendToolUse);
  const applyUsage = useStore((s) => s.applyUsage);
  const setHomeDir = useStore((s) => s.setHomeDir);
  const setVendors = useStore((s) => s.setVendors);
  const layout = useStore((s) => s.layout);
  const agents = useStore((s) => s.agents);
  const ptys = useStore((s) => s.ptys);
  const setActive = useStore((s) => s.setActive);

  useEffect(() => {
    api.homeDir().then(setHomeDir).catch(() => {});
    api.listVendors().then(setVendors).catch(() => {});
    api.listAgents().then((arr) => arr.forEach(upsertAgent)).catch(() => {});
    // Load persisted theme on first paint.
    api.settingsGetAll()
      .then((s) => applyTheme((s.theme as any) || "cyan"))
      .catch(() => {});
  }, [setHomeDir, setVendors, upsertAgent]);

  /// Resume a past agent: spawn fresh with --resume <session_id>, then
  /// pre-populate the chat panel with prior messages from the local DB.
  const onResume = async (h: HistoryAgent) => {
    try {
      const snap = await api.resumeAgent(h.spec, h.session_id);
      upsertAgent(snap);
      const past = await api.historyLoadMessages(h.id);
      // Stitch past messages into the new agent's panel so the user sees
      // continuity. The new spawn has a different id; we replay messages
      // under it so the existing ChatPanel just works.
      for (const m of past) {
        appendMessage(snap.id, {
          id: m.id,
          role: m.role as any,
          content: m.content,
          ts: m.ts,
          from_agent_id: m.from_agent_id,
          tool_name: m.tool_name ?? undefined,
          tool_input: m.tool_input,
        });
      }
    } catch (e) {
      console.error("resume failed", e);
    }
  };

  // Use a ref so the unlisten function is captured the moment listen() resolves,
  // even if the effect's cleanup has already run. The `cancelled` flag handles
  // the race where cleanup fires BEFORE the promise resolves.
  const unlistenRef = useRef<UnlistenFn | null>(null);
  useEffect(() => {
    let cancelled = false;
    listen<AgentEvent>("agent://event", (e) => {
      const ev = e.payload;
      switch (ev.kind) {
        case "created":
          upsertAgent(ev.snapshot);
          break;
        case "status":
          setStatus(ev.agent_id, ev.status);
          break;
        case "message":
          appendMessage(ev.agent_id, {
            id: crypto.randomUUID(),
            role: ev.role as any,
            content: ev.content,
            ts: ev.ts,
            from_agent_id: ev.from_agent_id,
          });
          break;
        case "tool_use":
          appendToolUse(ev.agent_id, ev.tool, ev.input, ev.ts);
          break;
        case "result":
          applyUsage(ev.agent_id, ev.usage);
          break;
        case "mention":
          // to_agent_id is now resolved server-side — no FE store lookup needed.
          if (ev.to_agent_id) {
            setMentionPulse({
              from: ev.from_agent_id,
              to: ev.to_agent_id,
              key: Date.now(),
            });
          }
          break;
        case "mention_blocked":
          // For now just log; could surface a toast later.
          console.warn(
            `[mention blocked] ${ev.from_agent_id} → @${ev.to_agent_name}: ${ev.reason}`,
          );
          break;
        case "exit":
          break;
      }
    }).then((u) => {
      if (cancelled) {
        // Cleanup already ran — unsubscribe immediately to avoid leak.
        u();
      } else {
        unlistenRef.current = u;
      }
    });
    return () => {
      cancelled = true;
      const u = unlistenRef.current;
      unlistenRef.current = null;
      u?.();
    };
  }, [upsertAgent, setStatus, appendMessage, appendToolUse, applyUsage]);

  const tiles = layout.filter((id) => agents[id] || ptys[id]);

  return (
    <div className="h-screen w-screen flex bg-base-950 text-base-200 grid-bg">
      <Sidebar
        onSpawn={() => setSpawnOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onResume={onResume}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <div className="h-11 border-b border-base-800 px-3 flex items-center gap-3 bg-base-900/40 backdrop-blur">
          <div className="flex items-center gap-1 text-xs text-base-500">
            <LayoutGrid size={12} />
            <span>{tiles.length} pane{tiles.length === 1 ? "" : "s"}</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ToolbarBtn
              active={rightPane === "feed"}
              onClick={() => setRightPane(rightPane === "feed" ? "off" : "feed")}
              icon={<Eye size={13} />}
              label="Activity"
            />
            <ToolbarBtn
              active={rightPane === "graph"}
              onClick={() => setRightPane(rightPane === "graph" ? "off" : "graph")}
              icon={<Network size={13} />}
              label="Graph"
            />
            <ToolbarBtn
              active={rightPane === "usage"}
              onClick={() => setRightPane(rightPane === "usage" ? "off" : "usage")}
              icon={<Zap size={13} />}
              label="Usage"
            />
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="flex-1 min-w-0 p-3 overflow-auto">
            {tiles.length === 0 ? (
              <EmptyState onSpawn={() => setSpawnOpen(true)} />
            ) : (
              <div
                className="grid gap-3 h-full"
                style={{
                  gridTemplateColumns: `repeat(${gridCols(tiles.length)}, minmax(0, 1fr))`,
                  gridAutoRows: "minmax(0, 1fr)",
                }}
              >
                {tiles.map((id) => (
                  <div
                    key={id}
                    className="min-h-0 min-w-0"
                    onClick={() => setActive(id)}
                  >
                    {agents[id] ? (
                      <ChatPanel agentId={id} />
                    ) : ptys[id] ? (
                      <TerminalPanel ptyId={id} />
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {rightPane !== "off" && (
            <div className="w-96 shrink-0 border-l border-base-800 p-3 bg-base-950/40">
              {rightPane === "feed" && <TeamFeed />}
              {rightPane === "graph" && <AgentGraph mentionPulse={mentionPulse} />}
              {rightPane === "usage" && <UsagePanel />}
            </div>
          )}
        </div>
      </main>

      <SpawnDialog open={spawnOpen} onClose={() => setSpawnOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function ToolbarBtn({
  active, onClick, icon, label,
}: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-2 py-1 text-xs rounded-md flex items-center gap-1 transition border",
        active
          ? "bg-(--color-accent-cyan)/15 text-(--color-accent-cyan) border-(--color-accent-cyan)/30"
          : "text-base-400 hover:text-base-200 border-transparent hover:bg-base-800/50",
      )}
    >
      {icon} {label}
    </button>
  );
}

function EmptyState({ onSpawn }: { onSpawn: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center">
      <div className="text-6xl mb-4 select-none">⌬</div>
      <div className="text-lg font-semibold mb-1">Multi-Agent Control Center</div>
      <div className="text-sm text-base-500 mb-6 max-w-md">
        Spawn multiple Claude agents that can work in parallel and talk to each
        other using <span className="text-(--color-accent-cyan)">@AgentName</span>.
        Watch them collaborate in the Activity feed and Graph view.
      </div>
      <button
        onClick={onSpawn}
        className="px-4 py-2 rounded-md bg-(--color-accent-cyan)/20 hover:bg-(--color-accent-cyan)/30 border border-(--color-accent-cyan)/40 text-(--color-accent-cyan) text-sm transition"
      >
        + Spawn your first agent
      </button>
    </div>
  );
}

function gridCols(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}
