import { useEffect, useState } from "react";
import {
  Bot,
  Plus,
  Terminal,
  Folder,
  Activity,
  Zap,
  History,
  RotateCcw,
  Settings,
  KanbanSquare,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Logo } from "./Logo";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { api } from "../lib/api";
import { cn, statusColor, fmtCost, fmtNumber } from "../lib/cn";
import type { ExternalSession, HistoryAgent } from "../types";

interface Props {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSpawn: () => void;
  onOpenSettings: () => void;
  onOpenBoards: () => void;
  /// Resume a past agent — caller spawns a new agent with `--resume <session_id>`
  /// and pre-loads its message history into the store.
  onResume: (h: HistoryAgent) => Promise<void> | void;
}

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  onSpawn,
  onOpenSettings,
  onOpenBoards,
  onResume,
}: Props) {
  const agents = useStore(useShallow((s) => Object.values(s.agents)));
  const ptys = useStore(useShallow((s) => Object.values(s.ptys)));
  const activeId = useStore((s) => s.activeTileId);
  const setActive = useStore((s) => s.setActive);
  const removeAgent = useStore((s) => s.removeAgent);
  const removePty = useStore((s) => s.removePty);

  const [externals, setExternals] = useState<ExternalSession[]>([]);
  const [externalsOpen, setExternalsOpen] = useState(false);
  const [history, setHistory] = useState<HistoryAgent[]>([]);
  const [historyOpen, setHistoryOpen] = useState(true);

  useEffect(() => {
    refreshExternals();
    refreshHistory();
  }, []);

  const refreshExternals = () => {
    api.listExternalSessions().then(setExternals).catch(() => {});
  };

  const refreshHistory = () => {
    api.historyListAgents(20).then(setHistory).catch(() => {});
  };

  // Refresh history list whenever agents change (spawn / kill).
  useEffect(() => {
    refreshHistory();
  }, [agents.length]);

  // Hide active agents from history — they're shown above already.
  const liveIds = new Set(agents.map((a) => a.snapshot.id));
  const pastAgents = history.filter((h) => !liveIds.has(h.id));

  const totalCost = agents.reduce((s, a) => s + a.snapshot.usage.total_cost_usd, 0);
  const totalTokens = agents.reduce(
    (s, a) => s + a.snapshot.usage.input_tokens + a.snapshot.usage.output_tokens,
    0,
  );
  const totalTurns = agents.reduce((s, a) => s + a.snapshot.usage.turns, 0);

  if (collapsed) {
    return (
      <aside className="w-14 shrink-0 border-r border-base-800 bg-base-900/70 flex flex-col items-center py-3 gap-2">
        <Logo size={34} />
        <IconButton
          onClick={onToggleCollapsed}
          icon={<PanelLeftOpen size={16} />}
          label="Expand sidebar"
        />
        <div className="h-px w-8 bg-base-800 my-1" />
        <IconButton onClick={onSpawn} icon={<Plus size={16} />} label="Spawn agent" primary />
        <IconButton onClick={onOpenBoards} icon={<KanbanSquare size={16} />} label="Task boards" />
        <IconButton onClick={onOpenSettings} icon={<Settings size={16} />} label="Settings" />
        <div className="h-px w-8 bg-base-800 my-1" />
        <div className="flex-1 min-h-0 w-full overflow-y-auto px-2 space-y-1">
          {agents.map((a) => (
            <button
              key={a.snapshot.id}
              onClick={() => setActive(a.snapshot.id)}
              className={cn(
                "h-9 w-9 rounded-md border flex items-center justify-center mx-auto transition relative",
                activeId === a.snapshot.id
                  ? "bg-(--color-accent-cyan)/10 border-(--color-accent-cyan)/40"
                  : "border-transparent hover:bg-base-800/60",
              )}
              title={`${a.snapshot.spec.name} - ${a.snapshot.spec.role}`}
            >
              <Bot size={15} className="text-base-300" />
              <span
                className={cn(
                  "absolute right-1 bottom-1 h-2 w-2 rounded-full ring-2 ring-base-900",
                  statusColor(a.snapshot.status),
                )}
              />
            </button>
          ))}
          {ptys.map((p) => (
            <button
              key={p.id}
              onClick={() => setActive(p.id)}
              className={cn(
                "h-9 w-9 rounded-md border flex items-center justify-center mx-auto transition",
                activeId === p.id
                  ? "bg-(--color-accent-violet)/10 border-(--color-accent-violet)/40"
                  : "border-transparent hover:bg-base-800/60",
              )}
              title={`${p.title} - ${p.cwd}`}
            >
              <Terminal size={15} className="text-(--color-accent-violet)" />
            </button>
          ))}
        </div>
        <div className="text-[10px] font-mono text-base-500" title="Live agents">
          {agents.length}
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-72 shrink-0 border-r border-base-800 bg-base-900/60 flex flex-col">
      {/* Header */}
      <div className="px-4 py-4 border-b border-base-800 flex items-center gap-3">
        <Logo size={40} />
        <div className="flex-1">
          <div className="text-sm font-semibold tracking-wide bg-gradient-to-r from-(--color-accent-cyan) to-(--color-accent-violet) bg-clip-text text-transparent">
            AGENT TEAM
          </div>
          <div className="text-[10px] text-base-500 tracking-widest">MONITOR · v0.1</div>
        </div>
        <button
          onClick={onToggleCollapsed}
          className="text-base-500 hover:text-(--color-accent-cyan) transition"
          title="Collapse sidebar"
        >
          <PanelLeftClose size={16} />
        </button>
        <button
          onClick={onOpenBoards}
          className="text-base-500 hover:text-(--color-accent-cyan) transition"
          title="Task boards"
        >
          <KanbanSquare size={16} />
        </button>
        <button
          onClick={onOpenSettings}
          className="text-base-500 hover:text-(--color-accent-cyan) transition"
          title="Settings"
        >
          <Settings size={16} />
        </button>
      </div>

      {/* Usage summary */}
      <div className="px-4 py-3 border-b border-base-800 grid grid-cols-3 gap-2">
        <Stat label="Agents" value={agents.length.toString()} icon={<Bot size={12} />} />
        <Stat label="Tokens" value={fmtNumber(totalTokens)} icon={<Zap size={12} />} />
        <Stat label="Cost" value={fmtCost(totalCost)} icon={<Activity size={12} />} />
      </div>
      <div className="px-4 py-2 text-[10px] text-base-500 border-b border-base-800">
        TOTAL TURNS: <span className="text-(--color-accent-cyan)">{totalTurns}</span>
      </div>

      {/* Spawn button */}
      <button
        onClick={onSpawn}
        className="mx-3 mt-3 mb-2 px-3 py-2 rounded-md bg-(--color-accent-cyan)/10 hover:bg-(--color-accent-cyan)/20 border border-(--color-accent-cyan)/30 text-(--color-accent-cyan) text-sm flex items-center justify-center gap-2 transition"
      >
        <Plus size={14} /> Spawn Agent
      </button>

      {/* Sections */}
      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-4">
        <Section label="Headless Agents" count={agents.length}>
          {agents.length === 0 && (
            <Empty>No agents yet. Spawn one to start.</Empty>
          )}
          {agents.map((a) => (
            <AgentRow
              key={a.snapshot.id}
              id={a.snapshot.id}
              name={a.snapshot.spec.name}
              role={a.snapshot.spec.role}
              status={a.snapshot.status}
              messages={a.snapshot.message_count}
              active={activeId === a.snapshot.id}
              onClick={() => setActive(a.snapshot.id)}
              onClose={async () => {
                await api.killAgent(a.snapshot.id).catch(() => {});
                removeAgent(a.snapshot.id);
              }}
            />
          ))}
        </Section>

        <Section label="Terminals" count={ptys.length}>
          {ptys.length === 0 && <Empty>No terminals open.</Empty>}
          {ptys.map((p) => (
            <PtyRow
              key={p.id}
              id={p.id}
              title={p.title}
              cwd={p.cwd}
              active={activeId === p.id}
              onClick={() => setActive(p.id)}
              onClose={async () => {
                await api.killPty(p.id).catch(() => {});
                removePty(p.id);
              }}
            />
          ))}
        </Section>

        <Section
          label="Recent Agents"
          count={pastAgents.length}
          collapsible
          open={historyOpen}
          onToggle={() => setHistoryOpen((v) => !v)}
        >
          {historyOpen && pastAgents.length === 0 && (
            <Empty>No past agents yet.</Empty>
          )}
          {historyOpen &&
            pastAgents.slice(0, 20).map((h) => (
              <HistoryRow key={h.id} h={h} onResume={async () => {
                await onResume(h);
                refreshHistory();
              }} onDelete={async () => {
                await api.historyDeleteAgent(h.id).catch(() => {});
                refreshHistory();
              }} />
            ))}
        </Section>

        <Section
          label="External Sessions"
          count={externals.length}
          collapsible
          open={externalsOpen}
          onToggle={() => setExternalsOpen((v) => !v)}
        >
          {externalsOpen &&
            externals.slice(0, 30).map((e) => (
              <div
                key={e.session_id}
                className="group px-2 py-1.5 rounded-md hover:bg-base-800/50 cursor-default flex items-start gap-2"
                title={e.jsonl_path}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate flex items-center gap-1.5">
                  <Folder size={11} className="text-base-500 shrink-0" />
                  <span className="truncate">{e.project_path ?? e.project_dir}</span>
                </div>
                <div className="text-[10px] text-base-500 ml-4">
                  {e.session_id.slice(0, 8)} · {fmtBytes(e.size_bytes)}
                </div>
                </div>
                <button
                  onClick={async (ev) => {
                    ev.stopPropagation();
                    await api.deleteExternalSession(e.jsonl_path).catch(() => {});
                    refreshExternals();
                  }}
                  className="shrink-0 opacity-0 group-hover:opacity-100 text-base-500 hover:text-(--color-accent-red) text-xs transition leading-none mt-0.5"
                  title="Delete external session file"
                >
                  ×
                </button>
              </div>
            ))}
        </Section>
      </div>
    </aside>
  );
}

function IconButton({
  onClick,
  icon,
  label,
  primary,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "h-9 w-9 rounded-md border flex items-center justify-center transition",
        primary
          ? "bg-(--color-accent-cyan)/12 text-(--color-accent-cyan) border-(--color-accent-cyan)/30 hover:bg-(--color-accent-cyan)/20"
          : "text-base-500 border-transparent hover:text-base-200 hover:bg-base-800/60",
      )}
    >
      {icon}
    </button>
  );
}

function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-base-800/50 rounded-md px-2 py-1.5 border border-base-700/50">
      <div className="text-[9px] text-base-500 flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="text-sm font-mono font-semibold text-base-200">{value}</div>
    </div>
  );
}

function Section({
  label,
  count,
  children,
  collapsible,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div>
      <button
        onClick={collapsible ? onToggle : undefined}
        className="w-full px-2 py-1 text-[10px] tracking-widest text-base-500 hover:text-base-300 flex items-center justify-between"
      >
        <span>{label}</span>
        <span className="font-mono">{count}</span>
      </button>
      {(!collapsible || open) && <div className="space-y-1">{children}</div>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-2 text-xs text-base-600 italic">{children}</div>;
}

function AgentRow({
  name,
  role,
  status,
  messages,
  active,
  onClick,
  onClose,
}: {
  id: string;
  name: string;
  role: string;
  status: string;
  messages: number;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group px-2 py-1.5 rounded-md cursor-pointer border transition",
        active
          ? "bg-(--color-accent-cyan)/10 border-(--color-accent-cyan)/40"
          : "bg-base-900/50 border-transparent hover:bg-base-800/60",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn("w-2 h-2 rounded-full shrink-0", statusColor(status))}
          title={status}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate font-medium">{name}</div>
          <div className="text-[10px] text-base-500 truncate">{role}</div>
        </div>
        <span className="text-[10px] font-mono text-base-500">{messages}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="opacity-0 group-hover:opacity-100 text-base-500 hover:text-(--color-accent-red) text-xs transition"
          title="Kill"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function PtyRow({
  title,
  cwd,
  active,
  onClick,
  onClose,
}: {
  id: string;
  title: string;
  cwd: string;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group px-2 py-1.5 rounded-md cursor-pointer border transition",
        active
          ? "bg-(--color-accent-violet)/10 border-(--color-accent-violet)/40"
          : "bg-base-900/50 border-transparent hover:bg-base-800/60",
      )}
    >
      <div className="flex items-center gap-2">
        <Terminal size={12} className="text-(--color-accent-violet) shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate font-medium">{title}</div>
          <div className="text-[10px] text-base-500 truncate" title={cwd}>{cwd}</div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="opacity-0 group-hover:opacity-100 text-base-500 hover:text-(--color-accent-red) text-xs transition"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function HistoryRow({
  h,
  onResume,
  onDelete,
}: {
  h: HistoryAgent;
  onResume: () => void;
  onDelete: () => void;
}) {
  const ago = relTime(h.last_seen_at);
  return (
    <div className="group px-2 py-1.5 rounded-md hover:bg-base-800/40 transition flex items-start gap-2">
      <History size={11} className="text-base-500 mt-1 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs truncate font-medium">{h.spec.name}</div>
        <div className="text-[10px] text-base-500 truncate">
          {h.message_count} msgs · {fmtNumber(h.usage.input_tokens + h.usage.output_tokens)} tok · {ago}
        </div>
      </div>
      <button
        onClick={onResume}
        className="opacity-0 group-hover:opacity-100 text-(--color-accent-cyan) hover:text-(--color-accent-cyan) text-[11px] transition"
        title={
          h.session_id
            ? `Restore Claude session ${h.session_id.slice(0, 8)} and remove this recent entry`
            : "Restore as a new live agent and remove this recent entry"
        }
      >
        <RotateCcw size={12} />
      </button>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 text-base-500 hover:text-(--color-accent-red) text-xs transition"
        title="Delete from history"
      >
        ×
      </button>
    </div>
  );
}

function relTime(iso: string): string {
  const ago = (Date.now() - +new Date(iso)) / 1000;
  if (ago < 60) return "just now";
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return `${Math.floor(ago / 86400)}d ago`;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}
