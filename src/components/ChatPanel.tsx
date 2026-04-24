import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Send, X, Wrench, ArrowRight, AtSign, Archive, BookOpen, ShieldCheck, ShieldX, Settings as Cog } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { api } from "../lib/api";
import { cn, statusColor, fmtCost, fmtNumber } from "../lib/cn";
import { findPreset, PRESETS } from "../lib/presets";
import { compactAgent } from "../lib/compact";
import { parseProposals, splitProposalBody, stripProposals, decisionKey } from "../lib/proposals";
import { SkillsDialog } from "./SkillsDialog";
import { AgentSettingsDialog } from "./AgentSettingsDialog";
import type { ChatMessage } from "../types";

/// Default model context window for the bar denominator. Sonnet/Opus are 200k,
/// Haiku is 200k. Override per-model later if needed.
const DEFAULT_CONTEXT_WINDOW = 200_000;

interface Props {
  agentId: string;
  onClose?: () => void;
}

export function ChatPanel({ agentId, onClose }: Props) {
  const record = useStore((s) => s.agents[agentId]);
  const agentsById = useStore(
    useShallow((s) =>
      Object.fromEntries(
        Object.values(s.agents).map((a) => [a.snapshot.id, a.snapshot]),
      ),
    ),
  );
  const [input, setInput] = useState("");
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Autocomplete state for `/commands` and `@mentions`.
  type SuggestItem = {
    label: string;       // displayed text
    insert: string;      // text to write into the input on accept
    hint?: string;       // small grey hint after the label
    /// "replace-all" — overwrite the whole input (slash commands).
    /// "replace-token" — replace just the @token at the caret (mentions).
    mode: "replace-all" | "replace-token";
  };
  const [suggest, setSuggest] = useState<{ items: SuggestItem[]; selected: number } | null>(
    null,
  );

  const computeSuggestions = (text: string, caret: number): SuggestItem[] => {
    // ---- Slash commands (must start at line beginning) ----
    if (text.startsWith("/")) {
      const parts = text.split(/\s+/);
      const cmdToken = parts[0].slice(1).toLowerCase();
      // First word? → command name suggestions.
      if (parts.length === 1) {
        const cmds: SuggestItem[] = [
          { label: "/agent", insert: "/agent ", hint: "spawn agent from preset", mode: "replace-all" },
          { label: "/spawn", insert: "/spawn ", hint: "alias of /agent", mode: "replace-all" },
          { label: "/kill", insert: "/kill ", hint: "terminate agent by name", mode: "replace-all" },
          { label: "/compact", insert: "/compact", hint: "summarize + restart this agent (frees context)", mode: "replace-all" },
          { label: "/list", insert: "/list", hint: "show current team", mode: "replace-all" },
          { label: "/help", insert: "/help", hint: "show all commands", mode: "replace-all" },
        ];
        return cmds.filter((c) => c.label.slice(1).toLowerCase().startsWith(cmdToken));
      }
      // /agent <preset...>  or  /spawn <preset...>
      if (cmdToken === "agent" || cmdToken === "spawn") {
        const partial = (parts[1] ?? "").toLowerCase();
        return PRESETS
          .filter((p) => p.name.toLowerCase().startsWith(partial))
          .map((p) => ({
            label: p.name,
            insert: `/${cmdToken} ${p.name}`,
            hint: p.role,
            mode: "replace-all" as const,
          }));
      }
      // /kill <name...>
      if (cmdToken === "kill") {
        const partial = (parts[1] ?? "").replace(/^@/, "").toLowerCase();
        return Object.values(useStore.getState().agents)
          .filter(
            (a) =>
              a.snapshot.id !== agentId &&
              a.snapshot.spec.name.toLowerCase().startsWith(partial),
          )
          .map((a) => ({
            label: `@${a.snapshot.spec.name}`,
            insert: `/kill ${a.snapshot.spec.name}`,
            hint: a.snapshot.spec.role,
            mode: "replace-all" as const,
          }));
      }
      return [];
    }

    // ---- @mentions (anywhere; trigger is `@` after start-of-line or whitespace) ----
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
    if (m) {
      const partial = m[1].toLowerCase();
      return Object.values(useStore.getState().agents)
        .filter(
          (a) =>
            a.snapshot.id !== agentId &&
            a.snapshot.spec.name.toLowerCase().startsWith(partial),
        )
        .map((a) => ({
          label: `@${a.snapshot.spec.name}`,
          insert: a.snapshot.spec.name,
          hint: a.snapshot.spec.role,
          mode: "replace-token" as const,
        }));
    }

    return [];
  };

  const refreshSuggest = (text: string, caret: number) => {
    const items = computeSuggestions(text, caret);
    if (items.length === 0) {
      setSuggest(null);
    } else {
      setSuggest((prev) => ({
        items,
        selected: Math.min(prev?.selected ?? 0, items.length - 1),
      }));
    }
  };

  const acceptSuggestion = () => {
    if (!suggest || suggest.items.length === 0) return;
    const item = suggest.items[suggest.selected];
    if (item.mode === "replace-all") {
      const newText = item.insert;
      setInput(newText);
      // Move caret to end after React applies the value.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.selectionStart = ta.selectionEnd = newText.length;
          ta.focus();
        }
      });
    } else {
      // Replace last @token before the caret with the chosen name.
      const ta = textareaRef.current;
      const caret = ta?.selectionStart ?? input.length;
      const before = input.slice(0, caret);
      const after = input.slice(caret);
      const replaced = before.replace(/@([A-Za-z0-9_-]*)$/, `@${item.insert} `);
      const newText = replaced + after;
      const newCaret = replaced.length;
      setInput(newText);
      requestAnimationFrame(() => {
        if (ta) {
          ta.selectionStart = ta.selectionEnd = newCaret;
          ta.focus();
        }
      });
    }
    setSuggest(null);
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [record?.messages.length]);

  if (!record) return null;
  const { snapshot, messages } = record;

  const upsertAgent = useStore((s) => s.upsertAgent);
  const removeAgent = useStore((s) => s.removeAgent);

  // Local-only message used to surface slash-command feedback in the chat
  // (success / failure / help). Doesn't go through the agent.
  const pushLocal = (content: string) => {
    useStore.getState().appendMessage(agentId, {
      id: crypto.randomUUID(),
      role: "system" as any,
      content: `[local] ${content}`,
      ts: new Date().toISOString(),
    });
  };

  const handleSlashCommand = async (raw: string): Promise<boolean> => {
    if (!raw.startsWith("/")) return false;
    const parts = raw.slice(1).trim().split(/\s+/);
    const cmd = (parts[0] ?? "").toLowerCase();
    const args = parts.slice(1);

    if (cmd === "help" || cmd === "?") {
      const presetList = PRESETS.map((p) => p.name).join(", ");
      pushLocal(
        `Slash commands:
/agent <Preset> [as <CustomName>]   spawn an agent from a preset (uses this agent's cwd)
/spawn <Preset> [as <CustomName>]   alias for /agent
/kill <Name>                        terminate an agent by name
/compact                            summarize this agent's context + restart it (frees context)
/list                               show current team
/help                               this help
Available presets: ${presetList}`,
      );
      return true;
    }

    if (cmd === "list") {
      const all = Object.values(useStore.getState().agents)
        .map((a) => `@${a.snapshot.spec.name} (${a.snapshot.status})`)
        .join(", ");
      pushLocal(`Current team: ${all || "(none)"}`);
      return true;
    }

    if (cmd === "agent" || cmd === "spawn") {
      if (args.length === 0) {
        pushLocal(`Usage: /agent <Preset> [as <CustomName>] — try one of: ${PRESETS.map((p) => p.name).join(", ")}`);
        return true;
      }
      const presetName = args[0];
      const preset = findPreset(presetName);
      if (!preset) {
        pushLocal(`Unknown preset "${presetName}". Available: ${PRESETS.map((p) => p.name).join(", ")}`);
        return true;
      }
      // Optional `as <CustomName>` clause; otherwise use the preset name.
      let customName = preset.name;
      const asIdx = args.findIndex((a) => a.toLowerCase() === "as");
      if (asIdx >= 0 && args[asIdx + 1]) {
        customName = args[asIdx + 1];
      }
      // Auto-suffix with a number if the name is taken.
      const taken = useStore.getState().agents;
      const existingNames = new Set(
        Object.values(taken).map((a) => a.snapshot.spec.name),
      );
      if (existingNames.has(customName)) {
        let i = 2;
        while (existingNames.has(`${customName}${i}`)) i++;
        customName = `${customName}${i}`;
      }
      try {
        const snap = await api.spawnAgent({
          name: customName,
          role: preset.role,
          cwd: snapshot.spec.cwd, // reuse current agent's cwd
          system_prompt: preset.system_prompt,
          model: null,
          color: preset.color,
          vendor: "claude",
          skip_permissions: false,
          allow_mentions: true,
          mention_allowlist: [],
        });
        upsertAgent(snap);
        pushLocal(`Spawned @${customName} (${preset.role}) in ${snapshot.spec.cwd}`);
      } catch (e: any) {
        pushLocal(`Spawn failed: ${e?.message ?? e}`);
      }
      return true;
    }

    if (cmd === "compact") {
      pushLocal("Compacting this agent — summarizing and respawning…");
      try {
        const r = await compactAgent(agentId);
        pushLocal(
          `Compacted: summary ${r.summary.length} chars · ${r.carriedMessages} messages preserved visually · new agent id ${r.newAgent.id.slice(0, 8)}`,
        );
      } catch (e: any) {
        pushLocal(`Compact failed: ${e?.message ?? e}`);
      }
      return true;
    }

    if (cmd === "kill") {
      if (args.length === 0) {
        pushLocal(`Usage: /kill <Name>`);
        return true;
      }
      const name = args[0].replace(/^@/, "");
      const target = Object.values(useStore.getState().agents).find(
        (a) => a.snapshot.spec.name === name,
      );
      if (!target) {
        pushLocal(`No agent named @${name}`);
        return true;
      }
      try {
        await api.killAgent(target.snapshot.id);
        removeAgent(target.snapshot.id);
        pushLocal(`Killed @${name}`);
      } catch (e: any) {
        pushLocal(`Kill failed: ${e?.message ?? e}`);
      }
      return true;
    }

    pushLocal(`Unknown command "/${cmd}". Type /help for the list.`);
    return true;
  };

  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");

    // Slash commands are intercepted locally (don't get sent to the agent).
    if (text.startsWith("/")) {
      // Echo the user's typed command so they can see what they ran.
      pushLocal(text);
      const handled = await handleSlashCommand(text);
      if (handled) return;
    }

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
        <ContextBar
          tokens={snapshot.current_context_tokens}
          cap={DEFAULT_CONTEXT_WINDOW}
          onCompact={async () => {
            try {
              await compactAgent(agentId);
            } catch (e) {
              console.error("compact failed", e);
            }
          }}
        />
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
        <button
          onClick={() => setSkillsOpen(true)}
          className="text-base-500 hover:text-(--color-accent-cyan) ml-1 transition"
          title="Skills & slash commands for this agent"
        >
          <BookOpen size={14} />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="text-base-500 hover:text-(--color-accent-cyan) ml-1 transition"
          title="Edit this agent's settings (kills + restarts on save)"
        >
          <Cog size={14} />
        </button>
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
            agentId={agentId}
            fromAgentName={
              m.from_agent_id ? agentsById[m.from_agent_id]?.spec.name : undefined
            }
          />
        ))}
      </div>

      <SkillsDialog
        open={skillsOpen}
        onClose={() => setSkillsOpen(false)}
        cwd={snapshot.spec.cwd}
        agentName={snapshot.spec.name}
        onRequestRestart={async () => {
          // Restart = compact (which kills + respawns with same spec).
          // Fresh process picks up the new skills/commands at startup.
          // We pass an empty-message shortcut: just kill+respawn without
          // summary, since the user explicitly wants a clean restart.
          try {
            await compactAgent(agentId);
            setSkillsOpen(false);
          } catch (e) {
            console.error("restart failed", e);
          }
        }}
      />

      <AgentSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        agentId={agentId}
      />

      {/* Input */}
      <div className="border-t border-base-800 p-2 bg-base-900/80">
        <div className="flex items-end gap-2 relative">
          {/* Autocomplete dropdown */}
          {suggest && suggest.items.length > 0 && (
            <div className="absolute bottom-full mb-1 left-0 right-12 max-h-56 overflow-y-auto rounded-md border border-base-700 bg-base-950/95 backdrop-blur shadow-xl z-20">
              <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-base-500 border-b border-base-800 flex items-center justify-between">
                <span>{suggest.items.length} suggestions</span>
                <span className="font-mono">↑↓ Tab/Enter Esc</span>
              </div>
              {suggest.items.map((it, i) => (
                <button
                  key={i}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep textarea focused
                    setSuggest({ items: suggest.items, selected: i });
                    acceptSuggestion();
                  }}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-sm flex items-baseline gap-2 transition",
                    i === suggest.selected
                      ? "bg-(--color-accent-cyan)/15 text-(--color-accent-cyan)"
                      : "hover:bg-base-800/60 text-base-200",
                  )}
                >
                  <span className="font-mono shrink-0">{it.label}</span>
                  {it.hint && (
                    <span className="text-[10px] text-base-500 truncate">— {it.hint}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              refreshSuggest(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => {
              const ta = e.currentTarget;
              refreshSuggest(ta.value, ta.selectionStart);
            }}
            onBlur={() => {
              // Delay so onMouseDown of suggestion can fire first.
              setTimeout(() => setSuggest(null), 100);
            }}
            onKeyDown={(e) => {
              // When suggest is open, hijack arrow / tab / enter / escape.
              if (suggest && suggest.items.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSuggest({
                    items: suggest.items,
                    selected: (suggest.selected + 1) % suggest.items.length,
                  });
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSuggest({
                    items: suggest.items,
                    selected:
                      (suggest.selected - 1 + suggest.items.length) % suggest.items.length,
                  });
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  acceptSuggestion();
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSuggest(null);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={`Message ${snapshot.spec.name}…  (type / for commands, @ for mentions)`}
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

const MessageBubble = memo(function MessageBubble({
  msg,
  agentId,
  fromAgentName,
}: {
  msg: ChatMessage;
  agentId: string;
  fromAgentName?: string;
}) {
  const ageSec = (Date.now() - +new Date(msg.ts)) / 1000;
  const fresh = ageSec < 5;

  if (msg.role === "system") {
    // Local-only system note (e.g. slash command echo / feedback).
    const body = msg.content.startsWith("[local] ")
      ? msg.content.slice("[local] ".length)
      : msg.content;
    return (
      <div className="text-[11px] text-base-500 font-mono whitespace-pre-wrap border-l-2 border-base-700 pl-2 py-0.5">
        {body}
      </div>
    );
  }

  // Detect <<PROPOSAL>>...<<END_PROPOSAL>> blocks in assistant text.
  // Render them as inline approval cards INSTEAD of the raw markers.
  const proposals = msg.role === "assistant" ? parseProposals(msg.content) : [];
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
  // For assistant messages with proposals, hide the raw markers from the bubble.
  const displayContent = proposals.length > 0 ? stripProposals(msg.content) : msg.content;

  return (
    <div className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
      {isRouted && (
        <div className="text-[10px] text-(--color-accent-violet) flex items-center gap-1 mb-0.5 font-mono">
          <AtSign size={10} />
          from <span className="font-semibold">{fromAgentName}</span>
          <ArrowRight size={10} />
        </div>
      )}
      {displayContent.length > 0 && (
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
          {displayContent}
        </div>
      )}
      {/* Approval cards (one per proposal in this message) */}
      {proposals.map((p) => (
        <ApprovalCard
          key={p.index}
          msgId={msg.id}
          proposal={p}
          agentId={agentId}
        />
      ))}
      <div className="text-[9px] text-base-600 mt-0.5 font-mono">
        {new Date(msg.ts).toLocaleTimeString()}
      </div>
    </div>
  );
});

function ApprovalCard({
  msgId, proposal, agentId,
}: {
  msgId: string;
  proposal: ReturnType<typeof parseProposals>[number];
  agentId: string;
}) {
  const key = decisionKey(msgId, proposal.index);
  const decision = useStore((s) => s.proposalDecisions[key]);
  const recordDecision = useStore((s) => s.recordDecision);
  const [denyReason, setDenyReason] = useState("");
  const [denying, setDenying] = useState(false);

  const { description, command } = useMemo(
    () => splitProposalBody(proposal.body),
    [proposal.body],
  );

  const send = async (text: string) => {
    try {
      await api.sendAgent(agentId, text);
    } catch (e) {
      console.error("approval send failed", e);
    }
  };

  const onApprove = async () => {
    recordDecision(key, "approved");
    await send("approved");
  };
  const onDeny = async () => {
    if (denying && !denyReason.trim()) {
      // Asked for reason but blank — fall back to generic deny.
    }
    const text = denyReason.trim()
      ? `denied: ${denyReason.trim()}`
      : "denied";
    recordDecision(key, "denied");
    setDenying(false);
    setDenyReason("");
    await send(text);
  };

  // Already decided — render compact summary with timestamp.
  if (decision) {
    const ok = decision.decision === "approved";
    return (
      <div
        className={cn(
          "max-w-[85%] mt-1 rounded-md px-3 py-1.5 text-[11px] font-mono flex items-center gap-2 border",
          ok
            ? "bg-(--color-accent-green)/10 border-(--color-accent-green)/30 text-(--color-accent-green)"
            : "bg-(--color-accent-red)/10 border-(--color-accent-red)/30 text-(--color-accent-red)",
        )}
      >
        {ok ? <ShieldCheck size={12} /> : <ShieldX size={12} />}
        Proposal {ok ? "approved" : "denied"} at{" "}
        {new Date(decision.ts).toLocaleTimeString()}
      </div>
    );
  }

  return (
    <div className="max-w-[85%] mt-1 rounded-md border border-(--color-accent-amber)/40 bg-(--color-accent-amber)/5 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-(--color-accent-amber)/30 flex items-center gap-2 text-[11px]">
        <span className="text-(--color-accent-amber) font-semibold flex items-center gap-1.5">
          <ShieldCheck size={12} /> Awaiting your approval
        </span>
      </div>
      {description && (
        <div className="px-3 py-2 text-sm whitespace-pre-wrap text-base-200">
          {description}
        </div>
      )}
      {command && (
        <pre className="mx-3 mb-2 rounded bg-base-950 border border-base-700/60 px-2 py-1.5 text-[11px] font-mono text-(--color-accent-amber) overflow-x-auto">
          {command}
        </pre>
      )}
      {denying ? (
        <div className="p-2 border-t border-(--color-accent-amber)/30 space-y-1.5">
          <input
            type="text"
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onDeny();
              if (e.key === "Escape") setDenying(false);
            }}
            autoFocus
            placeholder="Reason (optional) — sent back to the agent"
            className="w-full bg-base-950 border border-base-700 rounded px-2 py-1 text-xs outline-none focus:border-(--color-accent-red)/50"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setDenying(false)}
              className="px-2 py-1 text-[11px] rounded text-base-400 hover:bg-base-800/60"
            >
              Cancel
            </button>
            <button
              onClick={onDeny}
              className="px-2 py-1 text-[11px] rounded bg-(--color-accent-red)/20 hover:bg-(--color-accent-red)/30 border border-(--color-accent-red)/40 text-(--color-accent-red) flex items-center gap-1"
            >
              <ShieldX size={11} /> Send deny
            </button>
          </div>
        </div>
      ) : (
        <div className="p-2 border-t border-(--color-accent-amber)/30 flex justify-end gap-2">
          <button
            onClick={() => setDenying(true)}
            className="px-2 py-1 text-xs rounded text-(--color-accent-red) hover:bg-(--color-accent-red)/10 border border-(--color-accent-red)/30 flex items-center gap-1"
          >
            <ShieldX size={12} /> Deny
          </button>
          <button
            onClick={onApprove}
            className="px-3 py-1 text-xs rounded bg-(--color-accent-green)/20 hover:bg-(--color-accent-green)/30 border border-(--color-accent-green)/50 text-(--color-accent-green) flex items-center gap-1"
          >
            <ShieldCheck size={12} /> Approve
          </button>
        </div>
      )}
    </div>
  );
}

function ContextBar({
  tokens, cap, onCompact,
}: { tokens: number; cap: number; onCompact: () => void }) {
  const pct = cap > 0 ? Math.min(100, (tokens / cap) * 100) : 0;
  const overWarn = pct >= 75;
  const overDanger = pct >= 90;
  const color = overDanger
    ? "var(--color-accent-red)"
    : overWarn
    ? "var(--color-accent-amber)"
    : "var(--color-accent-cyan)";
  return (
    <div
      className="flex items-center gap-1.5"
      title={`Context: ${tokens.toLocaleString()} / ${cap.toLocaleString()} tokens (${pct.toFixed(0)}%) — click to /compact`}
    >
      <div className="flex flex-col items-end">
        <div className="text-[9px] font-mono" style={{ color }}>
          ctx {pct.toFixed(0)}%
        </div>
        <div className="w-16 h-1 rounded-full bg-base-800 overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: color }}
          />
        </div>
      </div>
      {tokens > 0 && (
        <button
          onClick={onCompact}
          className={cn(
            "p-1 rounded transition",
            overWarn
              ? "text-(--color-accent-amber) hover:bg-(--color-accent-amber)/20"
              : "text-base-500 hover:text-(--color-accent-cyan) hover:bg-base-800/50",
          )}
          title="Compact this agent (summarize + restart, free context)"
        >
          <Archive size={12} />
        </button>
      )}
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
