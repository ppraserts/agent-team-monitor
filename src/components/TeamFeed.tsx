import { useStore } from "../store";
import { ArrowRight, Wrench, MessageSquare, Activity, AtSign, Loader2 } from "lucide-react";
import { cn, statusColor } from "../lib/cn";
import { useEffect, useMemo, useState } from "react";

interface FeedItem {
  ts: string;
  kind: "message" | "tool" | "mention";
  agentId: string;
  agentName: string;
  role: string;          // "user" | "assistant" | "tool"
  content: string;
  fromAgentId?: string | null;
  fromAgentName?: string;
  status?: string;
}

export function TeamFeed() {
  const agents = useStore((s) => s.agents);

  // Tick to refresh "fresh" highlights.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const items: FeedItem[] = useMemo(() => {
    const all: FeedItem[] = [];
    const idToName = Object.fromEntries(
      Object.values(agents).map((a) => [a.snapshot.id, a.snapshot.spec.name]),
    );

    for (const r of Object.values(agents)) {
      for (const m of r.messages) {
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
    all.sort((a, b) => +new Date(b.ts) - +new Date(a.ts));
    return all.slice(0, 100);
  }, [agents]);

  const teamCount = Object.keys(agents).length;
  const mentionsCount = items.filter((i) => i.kind === "mention").length;
  const activeAgents = Object.values(agents).filter(
    (a) => a.snapshot.status === "thinking" || a.snapshot.status === "working",
  );

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

function FeedRow({ item, tick: _tick }: { item: FeedItem; tick: number }) {
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
  // message (assistant or plain user)
  const isAssistant = item.role === "assistant";
  return (
    <div
      className={cn(
        "rounded-md px-2 py-1.5 transition",
        fresh && isAssistant
          ? "bg-(--color-accent-cyan)/10 border border-(--color-accent-cyan)/30"
          : "bg-base-800/40",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] mb-0.5">
        <span
          className={cn("w-1.5 h-1.5 rounded-full", statusColor(item.status ?? "idle"))}
        />
        <MessageSquare size={11} className="text-base-500" />
        <span className="font-semibold text-base-200">{item.agentName}</span>
        <span
          className={cn(
            "text-[9px] px-1 rounded",
            isAssistant
              ? "bg-base-700 text-base-300"
              : "bg-base-800 text-base-500",
          )}
        >
          {item.role}
        </span>
        <span className="ml-auto text-[10px] text-base-600 font-mono">{time}</span>
      </div>
      <div className="text-xs text-base-400 whitespace-pre-wrap line-clamp-2">
        {item.content}
      </div>
    </div>
  );
}
