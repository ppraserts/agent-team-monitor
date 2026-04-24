import { useEffect, useState } from "react";
import {
  X, Database, Palette, Folder, Shield, Trash2, BarChart3, ExternalLink,
} from "lucide-react";
import { api } from "../lib/api";
import { cn, fmtCost, fmtNumber } from "../lib/cn";
import type { UsageStats } from "../types";

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
  const [defaultSkipPerms, setDefaultSkipPerms] = useState(false);
  const [defaultAllowMentions, setDefaultAllowMentions] = useState(true);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [dataPath, setDataPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!open) return;
    Promise.all([
      api.settingsGetAll(),
      api.usageStats(),
      api.dataPath(),
    ]).then(([s, st, dp]) => {
      setTheme((s.theme as ThemeKey) || "cyan");
      setDefaultCwd(s.default_cwd || "");
      setDefaultSkipPerms(s.default_skip_perms === "true");
      setDefaultAllowMentions(s.default_allow_mentions !== "false");
      setStats(st);
      setDataPath(dp);
      applyTheme((s.theme as ThemeKey) || "cyan");
    }).catch(console.error);
  }, [open]);

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
