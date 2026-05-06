import { useEffect, useState } from "react";
import {
  X, Database, Palette, Folder, Shield, Trash2, BarChart3, ExternalLink, Zap, Archive,
  MonitorCheck, Gauge,
} from "lucide-react";
import { api } from "../lib/api";
import { cn, fmtCost, fmtNumber } from "../lib/cn";
import { PLAN_DEFAULTS, type PlanTier } from "../lib/planLimits";
import type { RuntimeDiagnostics, UsageStats } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
}

const THEMES = [
  { key: "cyan", label: "Cyan", color: "oklch(0.78 0.18 200)" },
  { key: "violet", label: "Violet", color: "oklch(0.70 0.22 295)" },
  { key: "magenta", label: "Magenta", color: "oklch(0.72 0.24 340)" },
  { key: "green", label: "Green", color: "oklch(0.78 0.20 145)" },
  { key: "amber", label: "Amber", color: "oklch(0.82 0.18 80)" },
] as const;

type ThemeKey = (typeof THEMES)[number]["key"];

const THEME_VAR = "--color-accent-primary";

export function applyTheme(theme: ThemeKey) {
  const t = THEMES.find((x) => x.key === theme) ?? THEMES[0];
  document.documentElement.style.setProperty(THEME_VAR, t.color);
}

export function SettingsDialog({ open, onClose }: Props) {
  const [theme, setTheme] = useState<ThemeKey>("cyan");
  const [defaultCwd, setDefaultCwd] = useState("");
  const [defaultClaudeBin, setDefaultClaudeBin] = useState("");
  const [defaultSkipPerms, setDefaultSkipPerms] = useState(false);
  const [defaultAllowMentions, setDefaultAllowMentions] = useState(true);
  const [bitbucketAuthMode, setBitbucketAuthMode] = useState<"bearer" | "basic">("bearer");
  const [bitbucketUsername, setBitbucketUsername] = useState("");
  const [bitbucketAppPassword, setBitbucketAppPassword] = useState("");
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics | null>(null);
  const [dataPath, setDataPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // Plan / limits — mirror what claude.ai shows.
  const [planTier, setPlanTier] = useState<PlanTier>("max-20x");
  const [sessionLimit, setSessionLimit] = useState(PLAN_DEFAULTS["max-20x"].sessionLimit);
  const [weeklyAll, setWeeklyAll] = useState(PLAN_DEFAULTS["max-20x"].weeklyAllLimit);
  const [weeklySonnet, setWeeklySonnet] = useState(PLAN_DEFAULTS["max-20x"].weeklySonnetLimit);
  const [weeklyOpus, setWeeklyOpus] = useState(PLAN_DEFAULTS["max-20x"].weeklyOpusLimit);
  const [monthlySpend, setMonthlySpend] = useState(PLAN_DEFAULTS["max-20x"].monthlySpendLimit);
  const [resetDay, setResetDay] = useState(5);
  const [resetHour, setResetHour] = useState(7);
  const [extraSpent, setExtraSpent] = useState(0);
  const [extraResetDate, setExtraResetDate] = useState("");

  // Auto-compact
  const [autoCompactOn, setAutoCompactOn] = useState(false);
  const [autoCompactThreshold, setAutoCompactThreshold] = useState(85);
  const [harnessMaxTurns, setHarnessMaxTurns] = useState(0);
  const [harnessMaxToolCalls, setHarnessMaxToolCalls] = useState(0);
  const [harnessMaxCostUsd, setHarnessMaxCostUsd] = useState(0);
  const [harnessMaxRuntimeMin, setHarnessMaxRuntimeMin] = useState(0);

  useEffect(() => {
    if (!open) return;
    Promise.all([
      api.settingsGetAll(),
      api.usageStats(),
      api.dataPath(),
      api.runtimeDiagnostics(),
    ]).then(([s, st, dp, diag]) => {
      setTheme((s.theme as ThemeKey) || "cyan");
      setDefaultCwd(s.default_cwd || "");
      setDefaultClaudeBin(s.default_claude_bin || "");
      setDefaultSkipPerms(s.default_skip_perms === "true");
      setDefaultAllowMentions(s.default_allow_mentions !== "false");
      setBitbucketAuthMode(s.bitbucket_auth_mode === "basic" ? "basic" : "bearer");
      setBitbucketUsername(s.bitbucket_username || "");
      setBitbucketAppPassword(s.bitbucket_access_token || s.bitbucket_app_password || "");
      setStats(st);
      setDiagnostics(diag);
      setDataPath(dp);
      applyTheme((s.theme as ThemeKey) || "cyan");

      const tier = (s.plan_tier as PlanTier) || "max-20x";
      const d = PLAN_DEFAULTS[tier] ?? PLAN_DEFAULTS["max-20x"];
      setPlanTier(tier);
      setSessionLimit(numOr(s.plan_session_limit, d.sessionLimit));
      setWeeklyAll(numOr(s.plan_weekly_all_limit, d.weeklyAllLimit));
      setWeeklySonnet(numOr(s.plan_weekly_sonnet_limit, d.weeklySonnetLimit));
      setWeeklyOpus(numOr(s.plan_weekly_opus_limit, d.weeklyOpusLimit));
      setMonthlySpend(numOr(s.plan_monthly_spend_limit, d.monthlySpendLimit));
      setResetDay(numOr(s.plan_weekly_reset_day, 5));
      setResetHour(numOr(s.plan_weekly_reset_hour, 7));
      setExtraSpent(numOr(s.plan_extra_spent, 0));
      setExtraResetDate(s.plan_extra_reset_date || "");

      setAutoCompactOn(s.auto_compact === "true");
      setAutoCompactThreshold(numOr(s.auto_compact_threshold, 85));
      setHarnessMaxTurns(numOr(s.harness_max_turns, 0));
      setHarnessMaxToolCalls(numOr(s.harness_max_tool_calls, 0));
      setHarnessMaxCostUsd(numOr(s.harness_max_cost_usd, 0));
      setHarnessMaxRuntimeMin(Math.round(numOr(s.harness_max_runtime_ms, 0) / 60000));
    }).catch(console.error);
  }, [open]);

  const onTierChange = (t: PlanTier) => {
    setPlanTier(t);
    save("plan_tier", t);
    if (t !== "custom") {
      // Apply that tier's defaults (user can still override per-field).
      const d = PLAN_DEFAULTS[t];
      setSessionLimit(d.sessionLimit);
      setWeeklyAll(d.weeklyAllLimit);
      setWeeklySonnet(d.weeklySonnetLimit);
      setWeeklyOpus(d.weeklyOpusLimit);
      setMonthlySpend(d.monthlySpendLimit);
      save("plan_session_limit", String(d.sessionLimit));
      save("plan_weekly_all_limit", String(d.weeklyAllLimit));
      save("plan_weekly_sonnet_limit", String(d.weeklySonnetLimit));
      save("plan_weekly_opus_limit", String(d.weeklyOpusLimit));
      save("plan_monthly_spend_limit", String(d.monthlySpendLimit));
    }
  };

  const save = async (key: string, value: string) => {
    try {
      await api.settingsSet(key, value);
    } catch (e) {
      console.error(e);
    }
  };

  const onThemeChange = (k: ThemeKey) => {
    setTheme(k);
    applyTheme(k);
    save("theme", k);
  };

  const onClearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setBusy(true);
    try {
      await api.dataClearAll();
      const st = await api.usageStats();
      setStats(st);
      setConfirmClear(false);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-950/80 backdrop-blur-sm">
      <div className="glass rounded-xl w-[640px] max-w-[92vw] max-h-[88vh] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-base-800 flex items-center justify-between shrink-0">
          <div className="text-sm font-semibold tracking-wide flex items-center gap-2">
            <Shield size={14} className="text-(--color-accent-cyan)" /> SETTINGS
          </div>
          <button onClick={onClose} className="text-base-500 hover:text-base-200">
            <X size={16} />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-5">
          {/* ----- Theme ----- */}
          <Section icon={<Palette size={12} />} title="Theme accent">
            <div className="flex gap-2 flex-wrap">
              {THEMES.map((t) => (
                <button
                  key={t.key}
                  onClick={() => onThemeChange(t.key)}
                  className={cn(
                    "px-3 py-1.5 text-xs rounded-md border-2 transition flex items-center gap-2",
                    theme === t.key
                      ? "border-current"
                      : "border-base-700/60 hover:border-base-600",
                  )}
                  style={{ color: t.color }}
                >
                  <span
                    className="w-3 h-3 rounded-full"
                    style={{ background: t.color }}
                  />
                  {t.label}
                </button>
              ))}
            </div>
          </Section>

          {/* ----- Defaults ----- */}
          <Section icon={<Folder size={12} />} title="Defaults for new agents">
            <Field label="Default working directory">
              <input
                value={defaultCwd}
                onChange={(e) => setDefaultCwd(e.target.value)}
                onBlur={() => save("default_cwd", defaultCwd)}
                placeholder="C:\\devs\\..."
                className="input font-mono text-xs"
              />
            </Field>
            <Field label="Claude binary override">
              <input
                value={defaultClaudeBin}
                onChange={(e) => setDefaultClaudeBin(e.target.value)}
                onBlur={() => save("default_claude_bin", defaultClaudeBin.trim())}
                placeholder="C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd"
                className="input font-mono text-xs"
              />
            </Field>

            <ToggleRow
              checked={defaultAllowMentions}
              onChange={(v) => {
                setDefaultAllowMentions(v);
                save("default_allow_mentions", v ? "true" : "false");
              }}
              label="Allow mentions by default"
              hint="When ON, new agents have @mention routing enabled out of the box."
            />
            <ToggleRow
              checked={defaultSkipPerms}
              onChange={(v) => {
                setDefaultSkipPerms(v);
                save("default_skip_perms", v ? "true" : "false");
              }}
              danger
              label="--dangerously-skip-permissions by default"
              hint="DANGER: skips Claude's tool prompts. Combine with @mention routing only for trusted local work."
            />
          </Section>

          {/* ----- Review integrations ----- */}
          <Section icon={<Shield size={12} />} title="Review integrations">
            <Field label="Bitbucket auth mode">
              <select
                value={bitbucketAuthMode}
                onChange={(e) => {
                  const next = e.target.value === "basic" ? "basic" : "bearer";
                  setBitbucketAuthMode(next);
                  save("bitbucket_auth_mode", next);
                }}
                className="input text-xs"
              >
                <option value="bearer">Bearer access token</option>
                <option value="basic">Email/username + API token</option>
              </select>
            </Field>
            <Field label={bitbucketAuthMode === "basic" ? "Atlassian email or Bitbucket username" : "Bitbucket username (optional)"}>
              <input
                value={bitbucketUsername}
                onChange={(e) => setBitbucketUsername(e.target.value)}
                onBlur={() => save("bitbucket_username", bitbucketUsername.trim())}
                placeholder={bitbucketAuthMode === "basic" ? "your Atlassian account email" : "not required for access token"}
                className="input font-mono text-xs"
              />
            </Field>
            <Field label={bitbucketAuthMode === "basic" ? "Bitbucket API token" : "Bitbucket access token"}>
              <input
                type="password"
                value={bitbucketAppPassword}
                onChange={(e) => setBitbucketAppPassword(e.target.value)}
                onBlur={() => save("bitbucket_access_token", bitbucketAppPassword.trim())}
                placeholder={bitbucketAuthMode === "basic" ? "scoped API token with pull request read/write" : "token from Repository settings > Access tokens"}
                className="input font-mono text-xs"
              />
            </Field>
            <div className="text-[10px] text-base-500">
              Used by PR Reviews to fetch changed files and approve PRs. Repository access tokens use
              Bearer auth. Atlassian account API tokens use Basic auth with your account email and
              token.
            </div>
          </Section>

          {/* ----- Runtime diagnostics ----- */}
          <Section icon={<MonitorCheck size={12} />} title="Windows runtime diagnostics">
            {diagnostics ? (
              <div className="space-y-1">
                {diagnostics.checks.map((check) => (
                  <div
                    key={check.name}
                    className={cn(
                      "grid grid-cols-[72px_1fr] gap-2 rounded-md border px-2 py-1.5 text-xs",
                      check.ok
                        ? "border-base-700/50 bg-base-800/30"
                        : "border-(--color-accent-red)/40 bg-(--color-accent-red)/10",
                    )}
                  >
                    <div
                      className={cn(
                        "font-mono font-semibold",
                        check.ok ? "text-(--color-accent-green)" : "text-(--color-accent-red)",
                      )}
                    >
                      {check.name}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px]">
                        {check.binary ?? check.message ?? "not found"}
                      </div>
                      {check.version && (
                        <div className="truncate text-[10px] text-base-500">
                          {check.version}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-base-500">loading...</div>
            )}
            <div className="text-[10px] text-base-500">
              Required for the full app: npm/npx, Claude CLI, Cargo/Rust. Bun is optional.
            </div>
          </Section>

          {/* ----- Stats ----- */}
          <Section icon={<BarChart3 size={12} />} title="Usage statistics">
            {stats ? (
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Today input" value={fmtNumber(stats.today_input_tokens)} />
                <Stat label="Today output" value={fmtNumber(stats.today_output_tokens)} />
                <Stat label="Today cost" value={fmtCost(stats.today_cost_usd)} />
                <Stat label="Total turns" value={stats.total_turns.toString()} />
                <Stat label="All-time input" value={fmtNumber(stats.total_input_tokens)} />
                <Stat label="All-time output" value={fmtNumber(stats.total_output_tokens)} />
                <Stat label="All-time cost" value={fmtCost(stats.total_cost_usd)} />
                <Stat label="Total agents" value={stats.total_agents.toString()} />
              </div>
            ) : (
              <div className="text-xs text-base-500">loading…</div>
            )}
          </Section>

          {/* ----- Auto-compact ----- */}
          <Section icon={<Archive size={12} />} title="Auto-compact">
            <ToggleRow
              checked={autoCompactOn}
              onChange={(v) => {
                setAutoCompactOn(v);
                save("auto_compact", v ? "true" : "false");
              }}
              label="Auto-compact agents when context gets full"
              hint="When an agent's context exceeds the threshold below, the app asks it to summarize itself, kills the process, and respawns with the summary in the system prompt. The chat history above remains visible. Long sessions never crash, but the agent loses turn-by-turn detail beyond the summary."
            />
            <Field label={`Threshold (% of 200k context window) — current: ${autoCompactThreshold}%`}>
              <input
                type="range"
                min={50}
                max={95}
                step={1}
                value={autoCompactThreshold}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setAutoCompactThreshold(v);
                  save("auto_compact_threshold", String(v));
                }}
                className="w-full accent-(--color-accent-cyan)"
              />
            </Field>
          </Section>

          <Section icon={<Gauge size={12} />} title="Reliability harness defaults">
            <div className="text-[10px] text-base-500">
              Zero means unlimited. Non-zero budgets are copied into new agents and enforced by the backend with an audit event and kill switch.
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="Max turns per agent"
                value={harnessMaxTurns}
                onChange={(v) => {
                  setHarnessMaxTurns(v);
                  save("harness_max_turns", String(Math.max(0, Math.floor(v))));
                }}
              />
              <NumberField
                label="Max tool calls per agent"
                value={harnessMaxToolCalls}
                onChange={(v) => {
                  setHarnessMaxToolCalls(v);
                  save("harness_max_tool_calls", String(Math.max(0, Math.floor(v))));
                }}
              />
              <NumberField
                label="Max cost per agent ($)"
                value={harnessMaxCostUsd}
                step={0.01}
                onChange={(v) => {
                  setHarnessMaxCostUsd(v);
                  save("harness_max_cost_usd", String(Math.max(0, v)));
                }}
              />
              <NumberField
                label="Max runtime per agent (minutes)"
                value={harnessMaxRuntimeMin}
                onChange={(v) => {
                  const minutes = Math.max(0, Math.floor(v));
                  setHarnessMaxRuntimeMin(minutes);
                  save("harness_max_runtime_ms", String(minutes * 60000));
                }}
              />
            </div>
          </Section>

          {/* ----- Plan limits (mirrors claude.ai) ----- */}
          <Section icon={<Zap size={12} />} title="Plan & limits (used by Usage panel)">
            <Field label="Plan tier (selecting one applies its defaults — override below)">
              <select
                value={planTier}
                onChange={(e) => onTierChange(e.target.value as PlanTier)}
                className="input"
              >
                <option value="pro">Pro</option>
                <option value="max-5x">Max (5x)</option>
                <option value="max-20x">Max (20x)</option>
                <option value="custom">Custom</option>
              </select>
            </Field>
            <div className="text-[10px] text-base-500 -mt-1 mb-1">
              Copy exact values from{" "}
              <a
                href="https://claude.ai/settings/limits"
                target="_blank"
                rel="noreferrer"
                className="text-(--color-accent-cyan) underline"
              >
                claude.ai/settings/limits
              </a>{" "}
              for accurate %.
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="Session limit (tokens / 5h block)"
                value={sessionLimit}
                onChange={(v) => { setSessionLimit(v); save("plan_session_limit", String(v)); }}
              />
              <NumberField
                label="Weekly: All models (tokens)"
                value={weeklyAll}
                onChange={(v) => { setWeeklyAll(v); save("plan_weekly_all_limit", String(v)); }}
              />
              <NumberField
                label="Weekly: Sonnet only (tokens)"
                value={weeklySonnet}
                onChange={(v) => { setWeeklySonnet(v); save("plan_weekly_sonnet_limit", String(v)); }}
              />
              <NumberField
                label="Weekly: Opus only (tokens)"
                value={weeklyOpus}
                onChange={(v) => { setWeeklyOpus(v); save("plan_weekly_opus_limit", String(v)); }}
              />
              <NumberField
                label="Monthly extra-usage cap ($)"
                value={monthlySpend}
                onChange={(v) => { setMonthlySpend(v); save("plan_monthly_spend_limit", String(v)); }}
              />
              <Field label="Weekly reset day">
                <select
                  value={resetDay}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setResetDay(v); save("plan_weekly_reset_day", String(v));
                  }}
                  className="input"
                >
                  {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d, i) => (
                    <option key={i} value={i}>{d}</option>
                  ))}
                </select>
              </Field>
              <NumberField
                label="Weekly reset hour (0–23)"
                value={resetHour}
                onChange={(v) => { setResetHour(v); save("plan_weekly_reset_hour", String(v)); }}
              />
              <NumberField
                label="Current extra usage spent ($)"
                value={extraSpent}
                step={0.01}
                onChange={(v) => { setExtraSpent(v); save("plan_extra_spent", String(v)); }}
              />
              <Field label="Extra usage resets on (YYYY-MM-DD)">
                <input
                  type="date"
                  value={extraResetDate}
                  onChange={(e) => {
                    setExtraResetDate(e.target.value);
                    save("plan_extra_reset_date", e.target.value);
                  }}
                  className="input"
                />
              </Field>
            </div>
          </Section>

          {/* ----- Storage ----- */}
          <Section icon={<Database size={12} />} title="Storage">
            <div className="text-[10px] text-base-500 mb-1 uppercase tracking-wider">
              Database file
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[11px] bg-base-950 border border-base-700 rounded px-2 py-1.5 font-mono truncate">
                {dataPath || "loading…"}
              </code>
              <a
                href={`file://${dataPath}`}
                target="_blank"
                rel="noreferrer"
                className="text-base-500 hover:text-base-200"
                title="Open file location"
              >
                <ExternalLink size={14} />
              </a>
            </div>
            <div className="text-[10px] text-base-500 mt-1">
              SQLite (embedded). All agents, messages, usage, and settings live here.
            </div>

            <button
              onClick={onClearAll}
              disabled={busy}
              className={cn(
                "mt-3 px-3 py-1.5 text-xs rounded-md border transition flex items-center gap-2",
                confirmClear
                  ? "bg-(--color-accent-red)/20 border-(--color-accent-red)/60 text-(--color-accent-red)"
                  : "bg-base-800/50 border-base-700/60 text-base-300 hover:bg-base-700/60",
              )}
            >
              <Trash2 size={12} />
              {confirmClear ? "Click again to confirm — wipes all history" : "Clear all data"}
            </button>
          </Section>
        </div>

        <div className="px-4 py-3 border-t border-base-800 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm rounded-md bg-base-800/60 hover:bg-base-700/60 text-base-200"
          >
            Done
          </button>
        </div>
      </div>

      <style>{`
        .input {
          width: 100%;
          background: var(--color-base-950);
          border: 1px solid var(--color-base-700);
          border-radius: 6px;
          padding: 6px 10px;
          font-size: 13px;
          outline: none;
        }
        .input:focus { border-color: color-mix(in oklch, var(--color-accent-cyan) 50%, transparent); }
      `}</style>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="text-[10px] tracking-wider text-base-400 uppercase mb-2 flex items-center gap-1.5">
        {icon} {title}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] tracking-wider text-base-500 mb-1 uppercase">{label}</div>
      {children}
    </div>
  );
}

function NumberField({
  label, value, onChange, step,
}: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        step={step ?? 1}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="input font-mono text-xs"
      />
    </Field>
  );
}

function numOr(s: string | undefined, fallback: number): number {
  if (s == null || s === "") return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function ToggleRow({
  checked,
  onChange,
  label,
  hint,
  danger,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 accent-(--color-accent-cyan)"
      />
      <div className="flex-1">
        <div
          className={cn(
            "text-xs font-medium",
            danger && checked && "text-(--color-accent-red)",
          )}
        >
          {label}
        </div>
        {hint && (
          <div
            className={cn(
              "text-[10px] mt-0.5",
              danger && checked
                ? "text-(--color-accent-red)/80"
                : "text-base-500",
            )}
          >
            {hint}
          </div>
        )}
      </div>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-base-800/40 border border-base-700/40 rounded-md px-2 py-1.5">
      <div className="text-[10px] text-base-500">{label}</div>
      <div className="text-sm font-mono font-semibold">{value}</div>
    </div>
  );
}
