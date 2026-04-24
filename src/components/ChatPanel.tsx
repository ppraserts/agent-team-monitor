import { useEffect, useRef, useState } from "react";
import { Send, X, Wrench, ArrowRight, AtSign } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { api } from "../lib/api";
import { cn, statusColor, fmtCost, fmtNumber } from "../lib/cn";
import type { ChatMessage } from "../types";

interface Props {
  agentId: string;
  onClose?: () => void;
}

export function ChatPanel({ agentId, onClose }: Props) {
  const record = useStore((s) => s.agents[agentId]);
  const agentsByName = useStore(
    useShallow((s) =>
      Object.fromEntries(
        Object.values(s.agents).map((a) => [a.snapshot.spec.name, a.snapshot]),
      ),
    ),
  );
  const agentsById = useStore(
    useShallow((s) =>
      Object.fromEntries(
        Object.values(s.agents).map((a) => [a.snapshot.id, a.snapshot]),
      ),
    ),
  );
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [record?.messages.length]);

  if (!record) return null;
  const { snapshot, messages } = record;

  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    try {
      await api.sendAgent(agentId, text);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex flex-col h-full bg-base-900/40 border border-base-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-base-800 flex items-center gap-2 bg-base-900/80">
        <span
          className={cn(
            "w-2 h-2 rounded-full",
            statusColor(snapshot.status),
            snapshot.status === "thinking" || snapshot.status === "working"
              ? "pulse-ring"
              : "",
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate flex items-center gap-2">
            {snapshot.spec.name}
            <span className="text-[10px] font-normal text-base-500">
              {snapshot.spec.role}
            </span>
          </div>
          <div className="text-[10px] text-base-500 truncate font-mono">
            {snapshot.spec.cwd}
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono text-base-400">
          <span title="Total tokens">
            <span className="text-(--color-accent-cyan)">↓</span>{" "}
            {fmtNumber(snapshot.usage.input_tokens)}{" "}
            <span className="text-(--color-accent-violet)">↑</span>{" "}
            {fmtNumber(snapshot.usage.output_tokens)}
          </span>
          <span className="text-(--color-accent-amber)" title="Cost">
            {fmtCost(snapshot.usage.total_cost_usd)}
          </span>
          <span title="Turns">⟳ {snapshot.usage.turns}</span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-base-500 hover:text-base-200 ml-1"
            title="Close pane"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 scanline relative">
        {messages.length === 0 && (
          <div className="text-xs text-base-600 italic p-4 text-center">
            No messages yet. Type below to start the conversation.
            <br />
            Tip: use <span className="text-(--color-accent-cyan)">@AgentName</span>{" "}
            in the agent's reply to route to another agent.
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            msg={m}
            fromAgentName={
              m.from_agent_id ? agentsById[m.from_agent_id]?.spec.name : undefined
            }
          />
        ))}
      </div>

      {/* Input */}
      <div className="border-t border-base-800 p-2 bg-base-900/80">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={`Message ${snapshot.spec.name}…  (try: @${
              Object.keys(agentsByName).find((n) => n !== snapshot.spec.name) ?? "Other"
            } can you help?)`}
            rows={2}
            className="flex-1 resize-none bg-base-950 border border-base-700 rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-(--color-accent-cyan)/50"
          />
          <button
            onClick={submit}
            disabled={!input.trim()}
            className="px-3 py-2 rounded-md bg-(--color-accent-cyan)/20 hover:bg-(--color-accent-cyan)/30 border border-(--color-accent-cyan)/40 text-(--color-accent-cyan) disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-1"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  msg,
  fromAgentName,
}: {
  msg: ChatMessage;
  fromAgentName?: string;
}) {
  const ageSec = (Date.now() - +new Date(msg.ts)) / 1000;
  const fresh = ageSec < 5;
  if (msg.role === "tool") {
    return (
      <div className="flex items-start gap-2 text-[11px] text-base-500 font-mono pl-2 border-l-2 border-(--color-accent-amber)/30">
        <Wrench size={11} className="text-(--color-accent-amber) mt-0.5" />
        <div className="flex-1">
          <span className="text-(--color-accent-amber)">{msg.tool_name}</span>
          <span className="text-base-600 ml-2">
            {summarizeToolInput(msg.tool_input)}
          </span>
        </div>
      </div>
    );
  }

  const isUser = msg.role === "user";
  const isRouted = !!fromAgentName;

  return (
    <div className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
      {isRouted && (
        <div className="text-[10px] text-(--color-accent-violet) flex items-center gap-1 mb-0.5 font-mono">
          <AtSign size={10} />
          from <span className="font-semibold">{fromAgentName}</span>
          <ArrowRight size={10} />
        </div>
      )}
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words transition",
          isUser
            ? isRouted
              ? cn(
                  "bg-(--color-accent-violet)/15 border border-(--color-accent-violet)/30",
                  fresh && "glow-violet border-(--color-accent-violet)/60",
                )
              : "bg-(--color-accent-cyan)/10 border border-(--color-accent-cyan)/25"
            : cn(
                "bg-base-800/60 border border-base-700/60",
                fresh && "border-(--color-accent-cyan)/40",
              ),
        )}
      >
        {msg.content}
      </div>
      <div className="text-[9px] text-base-600 mt-0.5 font-mono">
        {new Date(msg.ts).toLocaleTimeString()}
      </div>
    </div>
  );
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const keys = ["file_path", "command", "pattern", "url", "path", "query"];
  for (const k of keys) {
    if (typeof obj[k] === "string") {
      const v = obj[k] as string;
      return v.length > 60 ? v.slice(0, 60) + "…" : v;
    }
  }
  return Object.keys(obj).join(", ");
}
