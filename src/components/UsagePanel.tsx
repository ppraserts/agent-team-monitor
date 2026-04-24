import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Zap, Info, ExternalLink, Target, Check } from "lucide-react";
import { api } from "../lib/api";
import { cn, fmtCost } from "../lib/cn";
import {
  calibrateLimit,
  DEFAULT_PLAN_SETTINGS,
  describeWeeklyReset,
  parsePlanSettings,
  timeUntilWeeklyReset,
  type PlanSettings,
} from "../lib/planLimits";
import type { CcusagePeriodEntry, CcusageReport } from "../types";

export function UsagePanel() {
  const [report, setReport] = useState<CcusageReport | null>(null);
  const [plan, setPlan] = useState<PlanSettings>(DEFAULT_PLAN_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [, setTick] = useState(0);

  const refresh = async () => {
    setLoading(true);
    try {
      const [r, s] = await Promise.all([
        api.ccusageReport(),
        api.settingsGetAll(),
      ]);
      setReport(r);
      setPlan(parsePlanSettings(s));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    const tt = setInterval(() => setTick((x) => x + 1), 30_000); // for "resets in" text
    return () => {
      clearInterval(t);
      clearInterval(tt);
    };
  }, []);

  // Latest current week / current 5-hour block from ccusage.
  const thisWeek = useMemo(
    () => latest(report?.weekly?.weekly ?? [], "week"),
    [report],
  );
  const currentBlock = useMemo(() => {
    const arr = report?.blocks?.blocks ?? [];
    return (arr.find((b) => b.isActive) ?? null) as any;
  }, [report]);

  // Per-model token tallies from this week.
  const sonnetTokens = useMemo(
    () => modelTokensForWeek(thisWeek, /sonnet/i),
    [thisWeek],
  );
  const opusTokens = useMemo(() => modelTokensForWeek(thisWeek, /opus/i), [thisWeek]);
  const haikuTokens = useMemo(() => modelTokensForWeek(thisWeek, /haiku/i), [thisWeek]);
  const allTokens = useMemo(
    () => (thisWeek ? thisWeek.inputTokens + thisWeek.outputTokens : 0),
    [thisWeek],
  );

  // Current session (5-hour block)
  const sessionTokens = currentBlock?.totalTokens ?? 0;
  const sessionEnd = currentBlock?.endTime
    ? new Date(currentBlock.endTime as string)
    : null;
  const sessionRemaining = useMemo(() => {
    if (!sessionEnd) return null;
    const ms = +sessionEnd - Date.now();
    if (ms <= 0) return null;
    const h = Math.floor(ms / (3600 * 1000));
    const m = Math.floor((ms / 60_000) % 60);
    return `${h} hr ${m} min`;
  }, [sessionEnd, report]);

  const resetText = describeWeeklyReset(plan.weeklyResetDay, plan.weeklyResetHour);
  const resetCountdown = timeUntilWeeklyReset(plan.weeklyResetDay, plan.weeklyResetHour);

  // When user calibrates a row, persist the back-computed limit then refresh.
  const onCalibrate = async (settingsKey: string, used: number, pct: number) => {
    const newLimit = calibrateLimit(used, pct);
    if (newLimit <= 0) return;
    try {
      await api.settingsSet(settingsKey, String(newLimit));
      // Also flip tier to custom so it doesn't get stomped by tier-default reset.
      await api.settingsSet("plan_tier", "custom");
      await refresh();
    } catch (e) {
      console.error("calibrate failed", e);
    }
  };

  return (
    <div className="flex flex-col h-full bg-base-900/40 border border-base-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-base-800 bg-base-900/80 flex items-center gap-2">
        <Zap size={14} className="text-(--color-accent-cyan)" />
        <div className="flex-1">
          <div className="text-sm font-semibold">Claude Usage</div>
          <div className="text-[10px] text-base-500">
            mirrors claude.ai/settings/limits · ccusage local data
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

      <div className="flex-1 overflow-y-auto p-4 space-y-6 text-sm">
        {/* ===== PLAN USAGE LIMITS ===== */}
        <Section
          title="Plan usage limits"
          aside={<span className="text-base-400 text-xs">{plan.label}</span>}
        >
          <UsageRow
            label="Current session"
            sublabel={
              sessionTokens > 0
                ? `Resets in ${sessionRemaining ?? "—"}`
                : "Starts when a message is sent"
            }
            used={sessionTokens}
            limit={plan.sessionLimit}
            onCalibrate={(p) => onCalibrate("plan_session_limit", sessionTokens, p)}
          />
        </Section>

        {/* ===== WEEKLY LIMITS ===== */}
        <Section
          title="Weekly limits"
          aside={
            <a
              href="https://support.anthropic.com"
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-(--color-accent-cyan) hover:underline flex items-center gap-1"
            >
              Learn more <ExternalLink size={10} />
            </a>
          }
        >
          <UsageRow
            label="All models"
            sublabel={`Resets ${resetText} (${resetCountdown})`}
            used={allTokens}
            limit={plan.weeklyAllLimit}
            onCalibrate={(p) => onCalibrate("plan_weekly_all_limit", allTokens, p)}
          />
          <UsageRow
            label="Sonnet only"
            sublabel={`Resets ${resetText}`}
            used={sonnetTokens}
            limit={plan.weeklySonnetLimit}
            onCalibrate={(p) => onCalibrate("plan_weekly_sonnet_limit", sonnetTokens, p)}
          />
          <UsageRow
            label="Opus only"
            sublabel={`Resets ${resetText}`}
            used={opusTokens}
            limit={plan.weeklyOpusLimit}
            onCalibrate={(p) => onCalibrate("plan_weekly_opus_limit", opusTokens, p)}
          />
          {haikuTokens > 0 && (
            <UsageRow
              label="Haiku (info)"
              sublabel="Not metered separately by Anthropic"
              used={haikuTokens}
              limit={0}
            />
          )}
        </Section>

        {/* ===== EXTRA USAGE ===== */}
        <Section title="Extra usage">
          <div className="text-[11px] text-base-500 mb-2 leading-relaxed">
            Anthropic's "extra usage" $ values are not in local files. Enter
            them once in Settings → Plan to mirror your claude.ai page.
          </div>
          <UsageRow
            label={`$${plan.extraSpent.toFixed(2)} spent`}
            sublabel={
              plan.extraResetDate ? `Resets ${plan.extraResetDate}` : "Set reset date in Settings"
            }
            used={plan.extraSpent}
            limit={plan.monthlySpendLimit}
            unit="dollar"
          />
          <div className="grid grid-cols-[200px_1fr_60px] items-center gap-3 py-2">
            <div>
              <div className="text-sm font-medium">${plan.monthlySpendLimit}</div>
              <div className="text-xs text-base-500">Monthly spend limit</div>
            </div>
            <div />
            <div className="text-right">
              <a
                href="#settings"
                className="text-[11px] text-base-400 hover:text-(--color-accent-cyan) underline"
              >
                Adjust
              </a>
            </div>
          </div>
        </Section>

        {/* Footer note */}
        <div className="text-[10px] text-base-500 leading-relaxed border-t border-base-800 pt-3 space-y-1.5">
          <div className="flex items-start gap-1.5">
            <Info size={10} className="mt-0.5 shrink-0 text-(--color-accent-cyan)" />
            <div>
              Token totals come from local <code>~/.claude/projects/*.jsonl</code>{" "}
              via ccusage. Plan limit values are configurable in{" "}
              <span className="text-base-300 font-semibold">Settings → Plan</span>{" "}
              — copy them from your{" "}
              <a
                href="https://claude.ai/settings/limits"
                target="_blank"
                rel="noreferrer"
                className="text-(--color-accent-cyan) underline"
              >
                claude.ai usage page
              </a>{" "}
              for exact-match bars.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  title, aside, children,
}: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-2 pb-2 border-b border-base-800">
        <h3 className="text-sm font-semibold text-base-200">{title}</h3>
        {aside}
      </div>
      <div>{children}</div>
    </section>
  );
}

function UsageRow({
  label, sublabel, used, limit, unit, onCalibrate,
}: {
  label: string;
  sublabel: string;
  used: number;
  limit: number;
  unit?: "dollar";
  /// Optional: when provided, render a tiny "calibrate" widget. The user
  /// types the % shown on claude.ai for this row; we back-compute the limit.
  onCalibrate?: (percentOnClaudeAi: number) => void;
}) {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  const cappedPct = Math.min(100, pct);
  const over = pct > 100;
  const [calibrating, setCalibrating] = useState(false);
  const [calValue, setCalValue] = useState("");
  return (
    <div className="grid grid-cols-[160px_1fr_70px] items-center gap-3 py-2.5">
      <div>
        <div className="text-sm font-medium flex items-center gap-1.5">
          {label}
          {onCalibrate && used > 0 && (
            <button
              onClick={() => {
                setCalibrating((v) => !v);
                setCalValue("");
              }}
              className="text-base-600 hover:text-(--color-accent-cyan) transition"
              title="Calibrate this bar against claude.ai's exact %"
            >
              <Target size={11} />
            </button>
          )}
        </div>
        <div className="text-[11px] text-base-500">{sublabel}</div>
      </div>

      {calibrating && onCalibrate ? (
        <div className="flex items-center gap-1.5 col-span-2">
          <span className="text-[11px] text-base-500 shrink-0">claude.ai shows:</span>
          <input
            type="number"
            value={calValue}
            onChange={(e) => setCalValue(e.target.value)}
            placeholder="9"
            min={0.1}
            max={100}
            step={0.1}
            autoFocus
            className="w-16 bg-base-950 border border-base-700 rounded px-2 py-0.5 text-xs font-mono outline-none focus:border-(--color-accent-cyan)"
          />
          <span className="text-[11px] text-base-500">%</span>
          <button
            onClick={() => {
              const p = Number(calValue);
              if (p > 0 && p <= 100) {
                onCalibrate(p);
                setCalibrating(false);
              }
            }}
            disabled={!calValue || Number(calValue) <= 0}
            className="ml-auto px-2 py-0.5 rounded bg-(--color-accent-cyan)/20 hover:bg-(--color-accent-cyan)/30 border border-(--color-accent-cyan)/40 text-(--color-accent-cyan) text-[11px] flex items-center gap-1 disabled:opacity-40"
            title="Back-compute limit and save"
          >
            <Check size={10} /> Save
          </button>
          <button
            onClick={() => setCalibrating(false)}
            className="text-base-500 hover:text-base-200 text-[11px]"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <div className="h-2 bg-base-800 rounded-full overflow-hidden relative">
            {limit > 0 ? (
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  over ? "bg-(--color-accent-red)" : "bg-(--color-accent-cyan)",
                )}
                style={{ width: `${cappedPct}%` }}
              />
            ) : (
              <div className="h-full w-full bg-base-700/30 [background:repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,0.05)_4px,rgba(255,255,255,0.05)_8px)]" />
            )}
          </div>
          <div className="text-right text-xs font-mono">
            {limit > 0 ? (
              <span className={cn(over ? "text-(--color-accent-red)" : "text-base-400")}>
                {Math.round(pct)}% used
              </span>
            ) : unit === "dollar" ? (
              <span className="text-base-500">{fmtCost(used)}</span>
            ) : (
              <span className="text-base-500">no limit</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function modelTokensForWeek(
  week: CcusagePeriodEntry | null,
  pattern: RegExp,
): number {
  if (!week) return 0;
  return week.modelBreakdowns
    .filter((m) => pattern.test(m.modelName))
    .reduce((acc, m) => acc + m.inputTokens + m.outputTokens, 0);
}

function latest<K extends "date" | "week" | "month">(
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
