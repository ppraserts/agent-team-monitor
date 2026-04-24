import { useEffect, useState } from "react";
import { Bot, Plus, Terminal, Folder, Activity, Zap } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { api } from "../lib/api";
import { cn, statusColor, fmtCost, fmtNumber } from "../lib/cn";
import type { ExternalSession } from "../types";

interface Props {
  onSpawn: () => void;
}

export function Sidebar({ onSpawn }: Props) {
  const agents = useStore(useShallow((s) => Object.values(s.agents)));
  const ptys = useStore(useShallow((s) => Object.values(s.ptys)));
  const activeId = useStore((s) => s.activeTileId);
  const setActive = useStore((s) => s.setActive);
  const removeAgent = useStore((s) => s.removeAgent);
  const removePty = useStore((s) => s.removePty);

  const [externals, setExternals] = useState<ExternalSession[]>([]);
  const [externalsOpen, setExternalsOpen] = useState(false);

  useEffect(() => {
    api.listExternalSessions().then(setExternals).catch(() => {});
  }, []);

  const totalCost = agents.reduce((s, a) => s + a.snapshot.usage.total_cost_usd, 0);
  const totalTokens = agents.reduce(
    (s, a) => s + a.snapshot.usage.input_tokens + a.snapshot.usage.output_tokens,
    0,
  );
  const totalTurns = agents.reduce((s, a) => s + a.snapshot.usage.turns, 0);

  return (
    <aside className="w-72 shrink-0 border-r border-base-800 bg-base-900/60 flex flex-col">
      {/* Header */}
      <div className="px-4 py-4 border-b border-base-800 flex items-center gap-3">
        <div className="relative">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-(--color-accent-cyan) to-(--color-accent-violet) flex items-center justify-center">
            <Bot size={20} className="text-base-950" />
          </div>
          <div className="absolute inset-0 rounded-lg pulse-ring text-(--color-accent-cyan)" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold tracking-wide">CLAUDE MONITOR</div>
          <div className="text-[10px] text-base-500 tracking-widest">MULTI-AGENT CONTROL</div>
        </div>
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
                className="px-2 py-1.5 rounded-md hover:bg-base-800/50 cursor-default"
                title={e.jsonl_path}
              >
                <div className="text-xs truncate flex items-center gap-1.5">
                  <Folder size={11} className="text-base-500" />
                  <span className="truncate">{e.project_path ?? e.project_dir}</span>
                </div>
                <div className="text-[10px] text-base-500 ml-4">
                  {e.session_id.slice(0, 8)} · {fmtBytes(e.size_bytes)}
                </div>
              </div>
            ))}
        </Section>
      </div>
    </aside>
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

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}
