import { useStore } from "../store";
import {
  ArrowRight,
  Wrench,
  Activity,
  AtSign,
  Loader2,
  Bot,
  UserRound,
  KanbanSquare,
  AlertTriangle,
} from "lucide-react";
import { cn, statusColor } from "../lib/cn";
import { memo, useEffect, useMemo, useState } from "react";

interface FeedItem {
  ts: string;
  kind: "message" | "tool" | "mention" | "board" | "process";
  agentId: string;
  agentName: string;
  role: string;          // "user" | "assistant" | "tool"
  content: string;
  fromAgentId?: string | null;
  fromAgentName?: string;
  status?: string;
  ok?: boolean;
  exitCode?: number | null;
}

export function TeamFeed() {
  const agents = useStore((s) => s.agents);
  const boardActivities = useStore((s) => s.boardActivities);
  const processActivities = useStore((s) => s.processActivities);

  // Tick to refresh "fresh" highlights — but only while there IS something
  // recent on screen. Constant 1Hz re-renders of the whole feed (which can
  // hold ~100 items) was visibly making the chat tile flicker on hot
  // conversations.
  const [tick, setTick] = useState(0);

  const items: FeedItem[] = useMemo(() => {
    const all: FeedItem[] = [];
    const idToName = Object.fromEntries(
      Object.values(agents).map((a) => [a.snapshot.id, a.snapshot.spec.name]),
    );

    for (const r of Object.values(agents)) {
      for (const m of r.messages) {
        const trimmed = (m.content ?? "").trim();
        // Skip purely-trivial acknowledgements ("...", "ok", "👍", emoji-only).
        // These are useful in the per-agent chat panel but make the global
        // activity feed noisy.
        const isTrivial =
          m.role !== "tool" &&
          (trimmed.length < 5 ||
            /^[\p{P}\p{S}\s]+$/u.test(trimmed));
        if (isTrivial) continue;

        if (m.role === "tool") {
          all.push({
            ts: m.ts, kind: "tool", role: "tool",
            agentId: r.snapshot.id, agentName: r.snapshot.spec.name,
            content: m.tool_name ?? m.content, status: r.snapshot.status,
          });
        } else if (m.role === "user" && m.from_agent_id) {
          all.push({
            ts: m.ts, kind: "mention", role: "user",
            agentId: r.snapshot.id, agentName: r.snapshot.spec.name,
            content: m.content,
            fromAgentId: m.from_agent_id,
            fromAgentName: idToName[m.from_agent_id] ?? "?",
            status: r.snapshot.status,
          });
        } else if (m.role === "assistant" || m.role === "user") {
          all.push({
            ts: m.ts, kind: "message", role: m.role,
            agentId: r.snapshot.id, agentName: r.snapshot.spec.name,
            content: m.content, status: r.snapshot.status,
          });
        }
      }
    }
    for (const a of boardActivities) {
      const record = agents[a.agentId];
      all.push({
        ts: a.ts,
        kind: "board",
        role: "tool",
        agentId: a.agentId,
        agentName: record?.snapshot.spec.name ?? "Agent",
        content: a.message,
        status: record?.snapshot.status,
        ok: a.ok,
      });
    }
    for (const p of processActivities) {
      const record = agents[p.agentId];
      const stderr = p.stderrTail.join("\n").trim();
      all.push({
        ts: p.ts,
        kind: "process",
        role: "system",
        agentId: p.agentId,
        agentName: p.agentName ?? record?.snapshot.spec.name ?? "Agent",
        content: stderr
          ? `exited with code ${p.code ?? "unknown"}\n${stderr}`
          : `exited with code ${p.code ?? "unknown"}`,
        status: "stopped",
        ok: p.code === 0,
        exitCode: p.code,
      });
    }
    all.sort((a, b) => +new Date(b.ts) - +new Date(a.ts));
    return all.slice(0, 100);
  }, [agents, boardActivities, processActivities]);

  const teamCount = Object.keys(agents).length;
  const mentionsCount = items.filter((i) => i.kind === "mention").length;
  const activeAgents = Object.values(agents).filter(
    (a) => a.snapshot.status === "thinking" || a.snapshot.status === "working",
  );

  // Only run the freshness ticker when there's a row created in the last 5s.
  const hasFresh = items.some(
    (it) => Date.now() - +new Date(it.ts) < 5000,
  );
  useEffect(() => {
    if (!hasFresh) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [hasFresh]);

  return (
    <div className="flex flex-col h-full bg-base-900/40 border border-base-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-base-800 bg-base-900/80">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-(--color-accent-cyan)" />
          <div className="flex-1">
            <div className="text-sm font-semibold">Team Activity</div>
            <div className="text-[10px] text-base-500">
              {teamCount} agents · <span className="text-(--color-accent-violet)">{mentionsCount} cross-agent</span>
            </div>
          </div>
        </div>

        {activeAgents.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {activeAgents.map((a) => (
              <div
                key={a.snapshot.id}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-(--color-accent-cyan)/15 border border-(--color-accent-cyan)/30 text-[10px] text-(--color-accent-cyan)"
              >
                <Loader2 size={9} className="animate-spin" />
                {a.snapshot.spec.name}
                <span className="text-base-500">· {a.snapshot.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {items.length === 0 && (
          <div className="text-xs text-base-600 italic p-4 text-center">
            No activity yet. When agents talk to each other via{" "}
            <span className="text-(--color-accent-cyan)">@AgentName</span>, you'll see
            it here as a live feed.
          </div>
        )}
        {items.map((it, i) => (
          <FeedRow key={`${it.ts}-${i}`} item={it} tick={tick} />
        ))}
      </div>
    </div>
  );
}

const FeedRow = memo(function FeedRow({
  item, tick: _tick,
}: { item: FeedItem; tick: number }) {
  const ageSec = (Date.now() - +new Date(item.ts)) / 1000;
  const fresh = ageSec < 5;
  const time = new Date(item.ts).toLocaleTimeString();

  if (item.kind === "mention") {
    return (
      <div
        className={cn(
          "rounded-md border p-2 transition",
          fresh
            ? "border-(--color-accent-violet) bg-(--color-accent-violet)/15 glow-violet"
            : "border-(--color-accent-violet)/30 bg-(--color-accent-violet)/5",
        )}
      >
        <div className="flex items-center gap-1.5 text-[11px] mb-1">
          <AtSign size={11} className="text-(--color-accent-violet)" />
          <span className="font-semibold text-(--color-accent-violet)">
            {item.fromAgentName}
          </span>
          <ArrowRight size={11} className="text-(--color-accent-violet)" />
          <span className="font-semibold text-base-200">{item.agentName}</span>
          {fresh && (
            <span className="text-[9px] px-1 rounded bg-(--color-accent-violet)/30 text-(--color-accent-violet) ml-1">
              LIVE
            </span>
          )}
          <span className="ml-auto text-[10px] text-base-600 font-mono">{time}</span>
        </div>
        <div className="text-xs text-base-200 whitespace-pre-wrap line-clamp-3">
          {item.content}
        </div>
      </div>
    );
  }
  if (item.kind === "tool") {
    return (
      <div className="flex items-center gap-2 text-[11px] px-2 py-1 text-base-500">
        <Wrench size={11} className="text-(--color-accent-amber)" />
        <span className="font-medium text-base-300">{item.agentName}</span>
        <span className="text-(--color-accent-amber)">{item.content}</span>
        <span className="ml-auto text-[10px] text-base-600 font-mono">{time}</span>
      </div>
    );
  }
  if (item.kind === "board") {
    return (
      <div
        className={cn(
          "rounded-md border px-2 py-1.5 transition",
          item.ok
            ? fresh
              ? "bg-(--color-accent-green)/10 border-(--color-accent-green)/35"
              : "bg-base-800/35 border-base-700/45"
            : "bg-(--color-accent-red)/10 border-(--color-accent-red)/35",
        )}
      >
        <div className="flex items-center gap-1.5 text-[11px] mb-1">
          <KanbanSquare
            size={12}
            className={item.ok ? "text-(--color-accent-green)" : "text-(--color-accent-red)"}
          />
          <span className="font-semibold text-base-200">{item.agentName}</span>
          <span className={item.ok ? "text-(--color-accent-green)" : "text-(--color-accent-red)"}>
            board
          </span>
          {fresh && (
            <span className="ml-1 text-[9px] px-1 rounded bg-(--color-accent-green)/20 text-(--color-accent-green)">
              LIVE
            </span>
          )}
          <span className="ml-auto text-[10px] text-base-600 font-mono">{time}</span>
        </div>
        <div className="text-xs text-base-300 whitespace-pre-wrap line-clamp-2">
          {item.content}
        </div>
      </div>
    );
  }
  if (item.kind === "process") {
    const clean = item.content.split("\n").filter(Boolean);
    const summary = clean[0] ?? "agent exited";
    const detail = clean.slice(1).join("\n");
    return (
      <div
        className={cn(
          "rounded-md border px-2 py-1.5 transition",
          item.ok
            ? "bg-base-800/25 border-base-700/40"
            : "bg-(--color-accent-red)/10 border-(--color-accent-red)/35",
        )}
      >
        <div className="flex items-center gap-1.5 text-[11px] mb-1">
          <AlertTriangle
            size={12}
            className={item.ok ? "text-base-500" : "text-(--color-accent-red)"}
          />
          <span className="font-semibold text-base-200">{item.agentName}</span>
          <span className={item.ok ? "text-base-500" : "text-(--color-accent-red)"}>
            process
          </span>
          <span className="ml-auto text-[10px] text-base-600 font-mono">{time}</span>
        </div>
        <div className="text-xs text-base-300 whitespace-pre-wrap line-clamp-4">
          {summary}
          {detail && (
            <>
              {"\n"}
              {detail}
            </>
          )}
        </div>
      </div>
    );
  }
  // message (assistant or plain user)
  const isAssistant = item.role === "assistant";
  const tone = isAssistant ? "agent" : "user";
  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1.5 transition",
        tone === "agent"
          ? fresh
            ? "bg-(--color-accent-cyan)/10 border-(--color-accent-cyan)/35"
            : "bg-base-800/35 border-base-700/45"
          : fresh
          ? "bg-(--color-accent-green)/10 border-(--color-accent-green)/35"
          : "bg-base-950/45 border-base-800",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] mb-1">
        <span
          className={cn("w-1.5 h-1.5 rounded-full", statusColor(item.status ?? "idle"))}
        />
        <span
          className={cn(
            "h-5 w-5 rounded-md border flex items-center justify-center",
            tone === "agent"
              ? "bg-(--color-accent-cyan)/10 border-(--color-accent-cyan)/30 text-(--color-accent-cyan)"
              : "bg-(--color-accent-green)/10 border-(--color-accent-green)/30 text-(--color-accent-green)",
          )}
        >
          {tone === "agent" ? <Bot size={12} /> : <UserRound size={12} />}
        </span>
        <span
          className={cn(
            "text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide",
            tone === "agent"
              ? "bg-(--color-accent-cyan)/15 text-(--color-accent-cyan)"
              : "bg-(--color-accent-green)/15 text-(--color-accent-green)",
          )}
        >
          {tone === "agent" ? "agent" : "user"}
        </span>
        <span className="font-semibold text-base-200">
          {tone === "agent" ? item.agentName : "You"}
        </span>
        <ArrowRight size={10} className="text-base-600" />
        <span className="text-base-400">
          {tone === "agent" ? "You" : item.agentName}
        </span>
        <span
          className={cn(
            "ml-1 text-[9px] px-1 rounded",
            fresh ? "bg-(--color-accent-cyan)/20 text-(--color-accent-cyan)" : "hidden",
          )}
        >
          LIVE
        </span>
        <span className="ml-auto text-[10px] text-base-600 font-mono">{time}</span>
      </div>
      <div
        className={cn(
          "text-xs whitespace-pre-wrap line-clamp-2",
          tone === "agent" ? "text-base-300" : "text-base-400",
        )}
      >
        {item.content}
      </div>
    </div>
  );
});
