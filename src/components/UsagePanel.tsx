import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Zap, Calendar, Clock, AlertCircle, Settings as Cog, Info } from "lucide-react";
import { api } from "../lib/api";
import { cn, fmtCost, fmtNumber } from "../lib/cn";
import type { CcusagePeriodEntry, CcusageReport, UsageStats } from "../types";

interface Props {
  /// Optional: max-token thresholds for the progress bars (used to render
  /// "% of plan" if the user has set their plan tier in settings).
  weeklyLimitTokens?: number;
}

export function UsagePanel({ weeklyLimitTokens }: Props) {
  const [report, setReport] = useState<CcusageReport | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [r, s] = await Promise.all([
        api.ccusageReport(),
        api.usageStats(),
      ]);
      setReport(r);
      setStats(s);
      setLastFetched(Date.now());
    } catch (e) {
      console.error("usage refresh failed", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const today = useMemo(
    () => latestByKey(report?.daily?.daily ?? [], "date"),
    [report],
  );
  const thisWeek = useMemo(
    () => latestByKey(report?.weekly?.weekly ?? [], "week"),
    [report],
  );
  const thisMonth = useMemo(
    () => latestByKey(report?.monthly?.monthly ?? [], "month"),
    [report],
  );

  const currentBlock = useMemo(() => {
    const arr = report?.blocks?.blocks ?? [];
    return arr.find((b) => b.isActive) ?? null;
  }, [report]);

  return (
    <div className="flex flex-col h-full bg-base-900/40 border border-base-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-base-800 bg-base-900/80 flex items-center gap-2">
        <Zap size={14} className="text-(--color-accent-cyan)" />
        <div className="flex-1">
          <div className="text-sm font-semibold">Claude Usage</div>
          <div className="text-[10px] text-base-500">
            from ~/.claude/projects · ccusage{" "}
            {lastFetched && (
              <span>· updated {Math.floor((Date.now() - lastFetched) / 1000)}s ago</span>
            )}
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-base-500 hover:text-(--color-accent-cyan) transition disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {report?.error && (
          <div className="rounded-md border border-(--color-accent-red)/40 bg-(--color-accent-red)/10 p-2 text-xs text-(--color-accent-red) flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Couldn't run ccusage</div>
              <div className="text-[10px] mt-0.5 font-mono">{report.error}</div>
              <div className="text-[10px] mt-1 text-base-400">
                Make sure Node.js is installed (we run <code>npx ccusage</code>).
              </div>
            </div>
          </div>
        )}

        {/* Current 5-hour block */}
        {currentBlock && (
          <Section icon={<Clock size={12} />} title="Current 5-hour block">
            <BlockCard block={currentBlock} />
          </Section>
        )}

        {/* Today */}
        {today && (
          <Section icon={<Calendar size={12} />} title={`Today (${today.date})`}>
            <PeriodCard entry={today} />
          </Section>
        )}

        {/* This week */}
        {thisWeek && (
          <Section
            icon={<Calendar size={12} />}
            title={`This week (from ${thisWeek.week})`}
          >
            <PeriodCard entry={thisWeek} limitTokens={weeklyLimitTokens} />
          </Section>
        )}

        {/* This month */}
        {thisMonth && (
          <Section
            icon={<Calendar size={12} />}
            title={`This month (${thisMonth.month})`}
          >
            <PeriodCard entry={thisMonth} />
          </Section>
        )}

        {/* In-app history (our own SQLite) */}
        {stats && (
          <Section icon={<Cog size={12} />} title="This app's contribution">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <KV k="Today (in)" v={fmtNumber(stats.today_input_tokens)} />
              <KV k="Today (out)" v={fmtNumber(stats.today_output_tokens)} />
              <KV k="Today cost" v={fmtCost(stats.today_cost_usd)} />
              <KV k="All-time cost" v={fmtCost(stats.total_cost_usd)} />
              <KV k="Total turns" v={stats.total_turns.toString()} />
              <KV k="Total agents" v={stats.total_agents.toString()} />
            </div>
          </Section>
        )}

        <div className="text-[10px] text-base-500 leading-relaxed border-t border-base-800 pt-3 mt-2 space-y-1.5">
          <div className="flex items-start gap-1.5">
            <Info size={10} className="mt-0.5 shrink-0 text-(--color-accent-cyan)" />
            <div>
              <span className="text-base-300 font-semibold">Cost = API-equivalent.</span>{" "}
              ccusage prices every token at Anthropic's <em>public API rate</em>.
              On Pro / Max plans you pay a flat subscription, so this is NOT what
              your card will be charged — it's a useful proxy for "how much
              Claude work you'd be paying for if you were on pure API billing."
            </div>
          </div>
          <div className="flex items-start gap-1.5">
            <Info size={10} className="mt-0.5 shrink-0 text-(--color-accent-cyan)" />
            <div>
              Numbers cover <span className="text-base-300 font-semibold">ALL Claude CLI usage</span>{" "}
              on this machine (anything that wrote to <code className="text-[9px]">~/.claude/projects/*.jsonl</code>),
              not just agents spawned from this app.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  icon, title, children,
}: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[10px] tracking-wider text-base-400 uppercase mb-1.5 flex items-center gap-1.5">
        {icon} {title}
      </div>
      {children}
    </section>
  );
}

function PeriodCard({
  entry, limitTokens,
}: {
  entry: CcusagePeriodEntry;
  limitTokens?: number;
}) {
  const totalNonCache = entry.inputTokens + entry.outputTokens;
  const pct = limitTokens ? Math.min(100, (totalNonCache / limitTokens) * 100) : null;
  return (
    <div className="rounded-md border border-base-700/40 bg-base-800/40 p-2 space-y-2">
      <div className="flex items-baseline gap-3 text-xs flex-wrap">
        <span className="text-(--color-accent-cyan) font-mono">↓ {fmtNumber(entry.inputTokens)}</span>
        <span className="text-(--color-accent-violet) font-mono">↑ {fmtNumber(entry.outputTokens)}</span>
        <span className="text-base-500 font-mono">cache {fmtNumber(entry.cacheReadTokens)}</span>
        <span
          className="ml-auto text-(--color-accent-amber) font-mono font-semibold"
          title="API-equivalent cost — see note at the bottom"
        >
          ≈ {fmtCost(entry.totalCost)}
        </span>
      </div>
      {pct !== null && (
        <div>
          <div className="flex items-baseline justify-between text-[10px] mb-0.5">
            <span className="text-base-500">vs your weekly limit ({fmtNumber(limitTokens!)} tok)</span>
            <span className={cn("font-mono", pct > 90 ? "text-(--color-accent-red)" : "text-base-400")}>
              {pct.toFixed(1)}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-base-900 overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                pct > 90 ? "bg-(--color-accent-red)" : "bg-(--color-accent-cyan)",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      {entry.modelBreakdowns.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-base-700/40">
          {entry.modelBreakdowns.map((m) => (
            <ModelBar key={m.modelName} m={m} totalCost={entry.totalCost} />
          ))}
        </div>
      )}
    </div>
  );
}

function ModelBar({
  m, totalCost,
}: {
  m: CcusagePeriodEntry["modelBreakdowns"][number];
  totalCost: number;
}) {
  const pct = totalCost > 0 ? (m.cost / totalCost) * 100 : 0;
  const short = shortModel(m.modelName);
  const color = modelColor(m.modelName);
  return (
    <div>
      <div className="flex items-baseline justify-between text-[10px] font-mono mb-0.5">
        <span style={{ color }}>{short}</span>
        <span className="text-base-500">
          {fmtNumber(m.inputTokens + m.outputTokens)} tok · {fmtCost(m.cost)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-base-900 overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

function BlockCard({ block }: { block: any }) {
  const start = block.startTime ? new Date(block.startTime) : null;
  const end = block.endTime ? new Date(block.endTime) : null;
  const now = new Date();
  const remainingMs = end ? +end - +now : 0;
  const elapsedMs = start ? +now - +start : 0;
  const blockMs = 5 * 60 * 60 * 1000;
  const elapsedPct = Math.min(100, Math.max(0, (elapsedMs / blockMs) * 100));

  return (
    <div className="rounded-md border border-(--color-accent-cyan)/30 bg-(--color-accent-cyan)/5 p-2 space-y-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-mono text-(--color-accent-cyan)">
          {start ? start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
          {" → "}
          {end ? end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
        </span>
        <span className="font-mono text-(--color-accent-amber)">
          {fmtCost(Number(block.totalCost ?? 0))}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-base-900 overflow-hidden">
        <div
          className="h-full rounded-full bg-(--color-accent-cyan) transition-all"
          style={{ width: `${elapsedPct}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-base-500 font-mono">
        <span>{fmtNumber(Number(block.totalTokens ?? 0))} tokens used</span>
        <span>
          {remainingMs > 0
            ? `${Math.floor(remainingMs / 60000)}m left`
            : "block ending"}
        </span>
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-base-800/40 border border-base-700/40 rounded-md px-2 py-1">
      <div className="text-[9px] text-base-500">{k}</div>
      <div className="text-sm font-mono font-semibold">{v}</div>
    </div>
  );
}

/// Take the entry with the largest value at `key` (latest period).
/// Empty array → null.
function latestByKey<K extends "date" | "week" | "month">(
  arr: CcusagePeriodEntry[],
  key: K,
): CcusagePeriodEntry | null {
  if (arr.length === 0) return null;
  return [...arr].sort((a, b) => {
    const av = (a[key] as string | undefined) ?? "";
    const bv = (b[key] as string | undefined) ?? "";
    return bv.localeCompare(av);
  })[0];
}

function shortModel(name: string): string {
  // claude-opus-4-5-20251101 -> opus-4-5
  // claude-haiku-4-5-20251001 -> haiku-4-5
  // claude-sonnet-4-5-... -> sonnet-4-5
  const m = name.match(/(opus|haiku|sonnet)-(\d+(?:[-.]\d+)*)/i);
  if (m) return `${m[1]}-${m[2]}`;
  return name.replace(/^claude-/, "");
}

function modelColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("opus")) return "oklch(0.70 0.22 295)"; // violet
  if (lower.includes("sonnet")) return "oklch(0.78 0.18 200)"; // cyan
  if (lower.includes("haiku")) return "oklch(0.82 0.18 80)"; // amber
  return "oklch(0.55 0.018 270)"; // grey
}
