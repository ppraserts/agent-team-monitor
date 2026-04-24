import { useEffect, useState } from "react";
import {
  X, Bot, Terminal as TerminalIcon, ShieldAlert, AtSign, Save, Trash2,
} from "lucide-react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { cn } from "../lib/cn";
import type { CustomPreset, VendorInfo } from "../types";

// Full software team. Each agent gets the same `TEAMMATES` line so it knows
// who else exists and how to address them.
const TEAMMATES =
  "@PM @Designer @Architect @Backend @Frontend @Mobile @DBA @DevOps @QA @Security @Reviewer @TechWriter";

const TEAM_PROTOCOL = (you: string, persona: string) => `You are the ${you} agent on a multi-agent software team.

ROLE: ${persona}

TEAM PROTOCOL:
- To delegate or ask a teammate, write \`@AgentName <message>\` on its own line.
- Available teammates: ${TEAMMATES}
- Only mention agents that already exist in the team. If a needed role isn't there, ask the user to spawn them.
- Keep replies concise and action-oriented. Don't repeat what teammates already said.
- When you finish a piece of work, summarize the result for the user in 1–3 lines.`;

interface Preset {
  name: string;
  group: "Planning" | "Engineering" | "Quality" | "Ops" | "Design";
  role: string;
  color: string;
  system_prompt: string;
}

const PRESETS: Preset[] = [
  // ---------------- Planning ----------------
  {
    name: "PM",
    group: "Planning",
    role: "Product manager — requirements, user stories, scope",
    color: "magenta",
    system_prompt: TEAM_PROTOCOL(
      "PM",
      "You translate vague user goals into concrete user stories and acceptance criteria. You decide WHAT gets built and in what order. You delegate technical design to @Architect, UX to @Designer, and quality concerns to @QA.",
    ),
  },
  {
    name: "Architect",
    group: "Planning",
    role: "System architect — high-level design, tradeoffs",
    color: "violet",
    system_prompt: TEAM_PROTOCOL(
      "Architect",
      "You break features into components, choose tech, identify risks. You delegate implementation to @Backend / @Frontend / @Mobile / @DBA. You consult @Security on auth/data flow and @DevOps on deploy/scale.",
    ),
  },
  // ---------------- Design ----------------
  {
    name: "Designer",
    group: "Design",
    role: "UI/UX designer — flows, wireframes, design system",
    color: "magenta",
    system_prompt: TEAM_PROTOCOL(
      "Designer",
      "You design user flows, screen layouts, and interaction patterns. You hand off to @Frontend / @Mobile with concrete component specs. You consult @PM on user goals and @TechWriter on copy.",
    ),
  },
  // ---------------- Engineering ----------------
  {
    name: "Backend",
    group: "Engineering",
    role: "Backend engineer — APIs, services, business logic",
    color: "cyan",
    system_prompt: TEAM_PROTOCOL(
      "Backend",
      "You implement server-side APIs and business logic. You ask @DBA for schema/query help, @Security for auth/threat checks, @DevOps for deploy/observability, and tell @Frontend / @Mobile when an API is ready.",
    ),
  },
  {
    name: "Frontend",
    group: "Engineering",
    role: "Frontend engineer — web UI implementation",
    color: "cyan",
    system_prompt: TEAM_PROTOCOL(
      "Frontend",
      "You implement web UI from @Designer's specs. You ask @Backend for API contracts, @Designer for missing states, and @QA when ready for testing.",
    ),
  },
  {
    name: "Mobile",
    group: "Engineering",
    role: "Mobile engineer — iOS / Android",
    color: "cyan",
    system_prompt: TEAM_PROTOCOL(
      "Mobile",
      "You implement native/cross-platform mobile UI. You ask @Backend for API contracts, @Designer for platform-specific patterns, and coordinate with @Frontend on shared logic.",
    ),
  },
  {
    name: "DBA",
    group: "Engineering",
    role: "Database engineer — schema, queries, migrations",
    color: "cyan",
    system_prompt: TEAM_PROTOCOL(
      "DBA",
      "You design schemas, write migrations, optimize queries. You consult @Architect on data model decisions and @Security on PII / encryption / access patterns.",
    ),
  },
  // ---------------- Ops ----------------
  {
    name: "DevOps",
    group: "Ops",
    role: "DevOps / SRE — CI/CD, infra, observability",
    color: "green",
    system_prompt: TEAM_PROTOCOL(
      "DevOps",
      "You handle CI/CD, infrastructure, monitoring, and deploys. You ask @Backend / @Frontend for build requirements, @Security for hardening, and surface incidents quickly.",
    ),
  },
  {
    name: "Security",
    group: "Ops",
    role: "Security engineer — threat model, auth, vulns",
    color: "red",
    system_prompt: TEAM_PROTOCOL(
      "Security",
      "You threat-model new features, audit auth flows, and flag risky patterns (SQL injection, XSS, secrets in logs, weak crypto). You push back hard via @Backend / @Frontend / @DevOps when you see risk.",
    ),
  },
  // ---------------- Quality ----------------
  {
    name: "QA",
    group: "Quality",
    role: "QA engineer — test plans, edge cases, regression",
    color: "amber",
    system_prompt: TEAM_PROTOCOL(
      "QA",
      "You write test plans, identify edge cases, run regression checks. You report bugs to @Backend / @Frontend / @Mobile with reproduction steps. You ask @PM for acceptance criteria when unclear.",
    ),
  },
  {
    name: "Reviewer",
    group: "Quality",
    role: "Code reviewer — bugs, smells, conventions",
    color: "amber",
    system_prompt: TEAM_PROTOCOL(
      "Reviewer",
      "You read code others produced and push back on bugs, dead code, missing error handling, unclear naming, and convention violations. Address authors directly via `@Backend / @Frontend / @Mobile <specific feedback>`. Be concrete, cite file:line.",
    ),
  },
  {
    name: "TechWriter",
    group: "Quality",
    role: "Tech writer — docs, README, API reference",
    color: "amber",
    system_prompt: TEAM_PROTOCOL(
      "TechWriter",
      "You write user-facing docs, READMEs, and API references. You ask @Backend / @Frontend / @Mobile for examples, @Designer for screenshots, and @PM for the user story behind the feature.",
    ),
  },
];

const GROUP_ORDER: Preset["group"][] = [
  "Planning",
  "Design",
  "Engineering",
  "Ops",
  "Quality",
];

const GROUP_COLOR: Record<Preset["group"], string> = {
  Planning: "var(--color-accent-violet)",
  Design: "var(--color-accent-magenta)",
  Engineering: "var(--color-accent-cyan)",
  Ops: "var(--color-accent-green)",
  Quality: "var(--color-accent-amber)",
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SpawnDialog({ open, onClose }: Props) {
  const upsertAgent = useStore((s) => s.upsertAgent);
  const upsertPty = useStore((s) => s.upsertPty);
  const homeDir = useStore((s) => s.homeDir);

  const [tab, setTab] = useState<"agent" | "terminal">("agent");
  const [vendors, setVendors] = useState<VendorInfo[]>([]);
  const [vendor, setVendor] = useState<string>("claude");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [cwd, setCwd] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Security toggles — defaults are SAFE; user opts in.
  const [skipPerms, setSkipPerms] = useState(false);
  const [allowMentions, setAllowMentions] = useState(true); // teamwork is the whole point — default on
  const [allowlist, setAllowlist] = useState(""); // comma-separated names; empty = any

  const [customPresets, setCustomPresets] = useState<CustomPreset[]>([]);

  // Load defaults from settings on every open + custom presets list.
  useEffect(() => {
    if (!open) return;
    api.settingsGetAll().then((s) => {
      if (s.default_cwd && !cwd) setCwd(s.default_cwd);
      if (s.default_skip_perms != null) setSkipPerms(s.default_skip_perms === "true");
      if (s.default_allow_mentions != null)
        setAllowMentions(s.default_allow_mentions !== "false");
    }).catch(() => {});
    api.presetsList().then(setCustomPresets).catch(() => {});
  }, [open]);

  const refreshCustomPresets = () =>
    api.presetsList().then(setCustomPresets).catch(() => {});

  const saveAsPreset = async () => {
    if (!name.trim()) return;
    const p: CustomPreset = {
      name: name.trim(),
      role: role.trim() || "Agent",
      color: null,
      group_name: "Custom",
      system_prompt: systemPrompt.trim() || null,
    };
    try {
      await api.presetsSave(p);
      await refreshCustomPresets();
    } catch (e) {
      console.error(e);
    }
  };

  const deleteCustomPreset = async (n: string) => {
    await api.presetsDelete(n);
    await refreshCustomPresets();
  };

  useEffect(() => {
    if (!open) return;
    api.listVendors().then(setVendors).catch(() => {});
    if (!cwd && homeDir) setCwd(homeDir);
  }, [open, homeDir, cwd]);

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setName(p.name);
    setRole(p.role);
    setSystemPrompt(p.system_prompt);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "agent") {
        const snap = await api.spawnAgent({
          name: name.trim(),
          role: role.trim() || "Agent",
          cwd: cwd.trim(),
          system_prompt: systemPrompt.trim() || null,
          model: null,
          color: null,
          vendor: "claude",
          skip_permissions: skipPerms,
          allow_mentions: allowMentions,
          mention_allowlist: allowlist
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        });
        upsertAgent(snap);
      } else {
        const snap = await api.spawnPty({
          title: name.trim() || "terminal",
          cwd: cwd.trim(),
          program: vendor === "claude" ? undefined : vendor,
          args: [],
        });
        upsertPty(snap);
      }
      onClose();
      setName("");
      setRole("");
      setSystemPrompt("");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-950/80 backdrop-blur-sm">
      <div className="glass rounded-xl w-[560px] max-w-[92vw] overflow-hidden">
        <div className="px-4 py-3 border-b border-base-800 flex items-center justify-between">
          <div className="text-sm font-semibold tracking-wide">SPAWN</div>
          <button onClick={onClose} className="text-base-500 hover:text-base-200">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 pt-3">
          <div className="flex gap-1 p-1 bg-base-900/60 rounded-md w-fit">
            <TabBtn active={tab === "agent"} onClick={() => setTab("agent")}>
              <Bot size={12} /> Headless Agent
            </TabBtn>
            <TabBtn active={tab === "terminal"} onClick={() => setTab("terminal")}>
              <TerminalIcon size={12} /> Terminal Pane
            </TabBtn>
          </div>
        </div>

        <div className="p-4 space-y-3">
          {tab === "agent" && (
            <>
              <Field label="Quick presets — full software team">
                <div className="space-y-1.5">
                  {GROUP_ORDER.map((g) => {
                    const items = PRESETS.filter((p) => p.group === g);
                    if (items.length === 0) return null;
                    return (
                      <div key={g} className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className="text-[9px] font-mono uppercase tracking-wider w-16 shrink-0"
                          style={{ color: GROUP_COLOR[g] }}
                        >
                          {g}
                        </span>
                        {items.map((p) => (
                          <button
                            key={p.name}
                            onClick={() => applyPreset(p)}
                            title={p.role}
                            className="px-2 py-1 text-xs rounded-md bg-base-800/60 hover:bg-base-700/60 border transition"
                            style={{
                              borderColor: `color-mix(in oklch, ${GROUP_COLOR[g]} 30%, transparent)`,
                            }}
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                  {customPresets.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[9px] font-mono uppercase tracking-wider w-16 shrink-0 text-base-400">
                        Custom
                      </span>
                      {customPresets.map((p) => (
                        <div key={p.name} className="group relative">
                          <button
                            onClick={() =>
                              applyPreset({
                                name: p.name,
                                group: "Quality",
                                role: p.role,
                                color: p.color ?? "amber",
                                system_prompt: p.system_prompt ?? "",
                              })
                            }
                            title={p.role}
                            className="px-2 py-1 text-xs rounded-md bg-base-800/60 hover:bg-base-700/60 border border-base-600/50 transition pr-6"
                          >
                            {p.name}
                          </button>
                          <button
                            onClick={() => deleteCustomPreset(p.name)}
                            className="absolute right-1 top-1/2 -translate-y-1/2 text-base-500 hover:text-(--color-accent-red) opacity-0 group-hover:opacity-100 transition"
                            title="Delete preset"
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Field>

              <Field label="Name (unique, used as @Name)">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Backend"
                  className="input"
                />
              </Field>
              <Field label="Role (free-form description)">
                <input
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="Senior backend engineer"
                  className="input"
                />
              </Field>
            </>
          )}

          {tab === "terminal" && (
            <Field label="Program">
              <select
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                className="input"
              >
                {vendors.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} — {v.binary}
                  </option>
                ))}
                <option value="powershell">powershell</option>
                <option value="cmd">cmd</option>
                <option value="bash">bash</option>
              </select>
            </Field>
          )}

          <Field label="Working directory">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={homeDir ?? "C:\\path\\to\\project"}
              className="input font-mono text-xs"
            />
          </Field>

          {tab === "agent" && (
            <Field label="System prompt (optional, sets the agent's role + team protocol)">
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={4}
                placeholder="You are…  (preset will fill this in)"
                className="input font-mono text-xs"
              />
            </Field>
          )}

          {tab === "agent" && (
            <div className="rounded-md border border-base-700/60 bg-base-900/40 p-3 space-y-2">
              <div className="text-[10px] tracking-wider text-base-500 uppercase mb-1">
                Security
              </div>

              <Toggle
                checked={allowMentions}
                onChange={setAllowMentions}
                icon={<AtSign size={12} />}
                label="Allow this agent to mention others"
                hint="When ON, `@AgentName <msg>` in this agent's reply forwards the message to that agent."
              />

              {allowMentions && (
                <Field label="Mention allowlist (comma-separated, empty = any agent)">
                  <input
                    value={allowlist}
                    onChange={(e) => setAllowlist(e.target.value)}
                    placeholder="Architect, Frontend"
                    className="input text-xs"
                  />
                </Field>
              )}

              <Toggle
                checked={skipPerms}
                onChange={setSkipPerms}
                icon={<ShieldAlert size={12} />}
                danger
                label="Pass --dangerously-skip-permissions"
                hint="DANGER: agent can run any tool (Bash, Edit, Write) without prompting. Combined with @mentions, a prompt-injected agent could instruct other agents to execute commands. Only enable for trusted local work."
              />
            </div>
          )}

          {error && (
            <div className="text-xs text-(--color-accent-red) bg-(--color-accent-red)/10 border border-(--color-accent-red)/30 rounded-md px-2 py-1.5">
              {error}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-base-800 flex justify-between items-center gap-2">
          {tab === "agent" ? (
            <button
              onClick={saveAsPreset}
              disabled={!name.trim()}
              className="px-3 py-1.5 text-xs rounded-md text-base-400 hover:text-base-200 hover:bg-base-800/60 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
              title="Save current name + role + system prompt as a reusable custom preset"
            >
              <Save size={12} /> Save as preset
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-md hover:bg-base-800/60 text-base-400"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={busy || !name.trim() || !cwd.trim()}
              className="px-4 py-1.5 text-sm rounded-md bg-(--color-accent-cyan)/20 hover:bg-(--color-accent-cyan)/30 border border-(--color-accent-cyan)/40 text-(--color-accent-cyan) disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "Spawning…" : "Spawn"}
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
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-3 py-1 text-xs rounded flex items-center gap-1.5 transition",
        active ? "bg-(--color-accent-cyan)/20 text-(--color-accent-cyan)" : "text-base-400 hover:text-base-200",
      )}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] tracking-wider text-base-500 mb-1 uppercase">{label}</div>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  icon,
  label,
  hint,
  danger,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  icon?: React.ReactNode;
  label: string;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 accent-(--color-accent-cyan)"
      />
      <div className="flex-1">
        <div
          className={cn(
            "text-xs flex items-center gap-1.5 font-medium",
            danger && checked && "text-(--color-accent-red)",
          )}
        >
          {icon}
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
