import { useEffect, useRef, useState } from "react";
import {
  X, Bot, Terminal as TerminalIcon, ShieldAlert, AtSign, Save, Trash2, ShieldCheck,
} from "lucide-react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { cn } from "../lib/cn";
import { shortPath } from "../lib/workspace";
import type { CustomPreset, VendorInfo } from "../types";
import { PRESETS, GROUP_ORDER, GROUP_COLOR, SAFETY_PROTOCOL } from "../lib/presets";


interface Props {
  open: boolean;
  onClose: () => void;
}

export function SpawnDialog({ open, onClose }: Props) {
  const upsertAgent = useStore((s) => s.upsertAgent);
  const upsertPty = useStore((s) => s.upsertPty);
  const homeDir = useStore((s) => s.homeDir);
  const activeWorkspace = useStore((s) => s.activeWorkspace);

  const [tab, setTab] = useState<"agent" | "terminal">("agent");
  const [vendors, setVendors] = useState<VendorInfo[]>([]);
  const [vendor, setVendor] = useState<string>("claude");
  const [vendorBinary, setVendorBinary] = useState("");
  const [defaultBins, setDefaultBins] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [cwd, setCwd] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Security toggles — defaults are SAFE; user opts in.
  const [skipPerms, setSkipPerms] = useState(false);
  const [allowMentions, setAllowMentions] = useState(true); // teamwork is the whole point — default on
  const [allowlist, setAllowlist] = useState(""); // comma-separated names; empty = any
  const [requireApproval, setRequireApproval] = useState(true);
  const [maxTurns, setMaxTurns] = useState(0);
  const [maxToolCalls, setMaxToolCalls] = useState(0);
  const [maxCostUsd, setMaxCostUsd] = useState(0);
  const [maxRuntimeMs, setMaxRuntimeMs] = useState(0);

  const [customPresets, setCustomPresets] = useState<CustomPreset[]>([]);
  const didAutoPickRuntime = useRef(false);

  // Load defaults from settings on every open + custom presets list.
  useEffect(() => {
    if (!open) return;
    api.settingsGetAll().then((s) => {
      if (!cwd) setCwd(activeWorkspace?.root ?? s.default_cwd ?? "");
      if (s.default_skip_perms != null) setSkipPerms(s.default_skip_perms === "true");
      if (s.default_allow_mentions != null)
        setAllowMentions(s.default_allow_mentions !== "false");
      const bins: Record<string, string> = {
        claude: s.default_claude_bin ?? "",
        codex: s.default_codex_bin ?? "",
      };
      setDefaultBins(bins);
      setVendorBinary(bins[vendor] ?? "");
      setMaxTurns(numOr(s.harness_max_turns, 0));
      setMaxToolCalls(numOr(s.harness_max_tool_calls, 0));
      setMaxCostUsd(numOr(s.harness_max_cost_usd, 0));
      setMaxRuntimeMs(numOr(s.harness_max_runtime_ms, 0));
    }).catch(() => {});
    api.presetsList().then(setCustomPresets).catch(() => {});
  }, [open, activeWorkspace?.root, cwd, vendor]);

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
    api.listVendors().then((items) => {
      setVendors(items);
      if (!didAutoPickRuntime.current && vendor === "claude" && items.some((v) => v.name === "codex")) {
        didAutoPickRuntime.current = true;
        setVendor("codex");
      }
    }).catch(() => {});
    if (!cwd) setCwd(activeWorkspace?.root ?? homeDir ?? "");
  }, [open, activeWorkspace?.root, homeDir, cwd]);

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setName(p.name);
    setRole(p.role);
    setSystemPrompt(p.system_prompt);
  };

  const runtimeOptions = vendors.filter((v) => v.name === "claude" || v.name === "codex");
  const vendorLabel = vendor === "codex" ? "Codex" : vendor === "claude" ? "Claude" : vendor;
  const vendorDefaultKey = vendor === "codex" ? "default_codex_bin" : "default_claude_bin";
  const modelOptions =
    vendor === "codex"
      ? [
          ["", "Codex default"],
          ["gpt-5.5", "GPT-5.5"],
          ["gpt-5.4", "GPT-5.4"],
          ["gpt-5.4-mini", "GPT-5.4 Mini"],
          ["gpt-5.3-codex", "GPT-5.3 Codex"],
          ["gpt-5.2", "GPT-5.2"],
        ]
      : [
          ["", "Claude default"],
          ["claude-opus-4-7", "Claude Opus 4.7"],
          ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
          ["claude-haiku-4-5", "Claude Haiku 4.5"],
          ["claude-opus-4-6", "Claude Opus 4.6"],
          ["claude-opus-4-5", "Claude Opus 4.5"],
          ["claude-opus-4-1", "Claude Opus 4.1"],
          ["claude-sonnet-4-5", "Claude Sonnet 4.5"],
        ];
  const conventionalCodexBin = homeDir
    ? `${homeDir}\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe`
    : "";

  useEffect(() => {
    if (!open || vendor !== "codex" || vendorBinary.trim()) return;
    const resolved = vendors.find((v) => v.name === "codex")?.binary;
    const fallback = defaultBins.codex || resolved || conventionalCodexBin;
    if (fallback) setVendorBinary(fallback);
  }, [open, vendor, vendorBinary, vendors, defaultBins.codex, conventionalCodexBin]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "agent") {
        // Append the user-approval protocol when require_approval is on.
        // The chat panel detects <<PROPOSAL>>...<<END_PROPOSAL>> blocks and
        // renders inline Approve / Deny buttons that reply on the user's behalf.
        const finalPrompt =
          (systemPrompt.trim() || "") +
          (requireApproval ? SAFETY_PROTOCOL : "");

        // IMPORTANT: in stream-json mode there are NO interactive permission
        // popups, so without --dangerously-skip-permissions every Edit/Write/
        // Bash call would fail silently. When require_approval is on, the
        // proposal flow IS the permission gate — flip skip_permissions on
        // automatically so Approve actually lets the tool run.
        const effectiveSkipPerms = skipPerms || requireApproval;

        const snap = await api.spawnAgent({
          name: name.trim(),
          role: role.trim() || "Agent",
          cwd: cwd.trim(),
          system_prompt: finalPrompt || null,
          model: model.trim() || null,
          reasoning_effort: vendor === "codex" ? reasoningEffort : null,
          color: null,
          vendor,
          vendor_binary:
            vendorBinary.trim() ||
            (vendor === "codex" ? conventionalCodexBin : "") ||
            null,
          workspace_id: activeWorkspace?.id ?? null,
          skip_permissions: effectiveSkipPerms,
          allow_mentions: allowMentions,
          mention_allowlist: allowlist
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          max_turns: maxTurns,
          max_tool_calls: maxToolCalls,
          max_cost_usd: maxCostUsd,
          max_runtime_ms: maxRuntimeMs,
        });
        upsertAgent(snap);
      } else {
        const snap = await api.spawnPty({
          title: name.trim() || "terminal",
          cwd: cwd.trim(),
          workspaceId: activeWorkspace?.id ?? null,
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
      <div className="glass rounded-xl w-[560px] max-w-[92vw] max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-base-800 flex items-center justify-between">
          <div className="text-sm font-semibold tracking-wide">SPAWN</div>
          <button onClick={onClose} className="text-base-500 hover:text-base-200">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 pt-3 shrink-0">
          <div className="flex gap-1 p-1 bg-base-900/60 rounded-md w-fit">
            <TabBtn active={tab === "agent"} onClick={() => setTab("agent")}>
              <Bot size={12} /> Headless Agent
            </TabBtn>
            <TabBtn active={tab === "terminal"} onClick={() => setTab("terminal")}>
              <TerminalIcon size={12} /> Terminal Pane
            </TabBtn>
          </div>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
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
              <Field label="Agent runtime">
                <select
                  value={vendor}
                  onChange={(e) => {
                    const next = e.target.value;
                    didAutoPickRuntime.current = true;
                    setVendor(next);
                    setVendorBinary(defaultBins[next] ?? "");
                    setModel("");
                    setReasoningEffort("medium");
                  }}
                  className="input"
                >
                  {runtimeOptions.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} - {v.binary}
                    </option>
                  ))}
                  {!runtimeOptions.some((v) => v.name === "claude") && (
                    <option value="claude">claude - resolved at spawn time</option>
                  )}
                  {!runtimeOptions.some((v) => v.name === "codex") && (
                    <option value="codex">codex - resolved at spawn time</option>
                  )}
                </select>
              </Field>
              <div className={cn("grid gap-2", vendor === "codex" ? "grid-cols-2" : "grid-cols-1")}>
                <Field label="Model">
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="input"
                  >
                    {modelOptions.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                {vendor === "codex" && (
                  <Field label="Reasoning effort">
                    <select
                      value={reasoningEffort}
                      onChange={(e) => setReasoningEffort(e.target.value)}
                      className="input"
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="xhigh">Extra High</option>
                    </select>
                  </Field>
                )}
              </div>
              <Field label={`${vendorLabel} binary override (optional)`}>
                <input
                  value={vendorBinary}
                  onChange={(e) => setVendorBinary(e.target.value)}
                  onBlur={() => {
                    const value = vendorBinary.trim();
                    setDefaultBins((prev) => ({ ...prev, [vendor]: value }));
                    api.settingsSet(vendorDefaultKey, value).catch(() => {});
                  }}
                  placeholder={
                    vendor === "codex"
                      ? conventionalCodexBin || "C:\\Users\\you\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe"
                      : "C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd"
                  }
                  className="input font-mono text-xs"
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
            {activeWorkspace && (
              <div className="mb-1 text-[10px] text-(--color-accent-cyan) font-mono truncate">
                Active workspace: {activeWorkspace.name} · {shortPath(activeWorkspace.root)}
              </div>
            )}
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
                checked={requireApproval}
                onChange={setRequireApproval}
                icon={<ShieldCheck size={12} />}
                label="Ask for approval before destructive ops (model-mediated)"
                hint="The agent is instructed to emit <<PROPOSAL>>...<<END_PROPOSAL>> before write / commit / install / deploy work. For Claude this enables skip-permissions after approval; for Codex it maps to bypassing Codex approvals/sandbox. Use only with trusted local work."
              />

              {!requireApproval && (
                <Toggle
                  checked={skipPerms}
                  onChange={setSkipPerms}
                  icon={<ShieldAlert size={12} />}
                  danger
                  label="Bypass runtime permission prompts (no approval gate)"
                  hint="DANGER: runtime tool calls may run without asking. Use only for trusted local automation."
                />
              )}
              {requireApproval && (
                <div className="text-[10px] text-base-500 ml-6 -mt-1">
                  (runtime permission bypass is implicit. Approval cards are enforced by the agent protocol, not by a host sandbox.)
                </div>
              )}
              {(maxTurns > 0 || maxToolCalls > 0 || maxCostUsd > 0 || maxRuntimeMs > 0) && (
                <div className="text-[10px] text-base-500 ml-6">
                  Harness: {maxTurns || "∞"} turns · {maxToolCalls || "∞"} tools ·{" "}
                  {maxCostUsd > 0 ? `$${maxCostUsd}` : "∞ cost"} ·{" "}
                  {maxRuntimeMs > 0 ? `${Math.round(maxRuntimeMs / 60000)} min` : "∞ time"}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="text-xs text-(--color-accent-red) bg-(--color-accent-red)/10 border border-(--color-accent-red)/30 rounded-md px-2 py-1.5">
              {error}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-base-800 flex justify-between items-center gap-2 shrink-0 bg-base-950/95">
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

function numOr(s: string | undefined, fallback: number): number {
  if (s == null || s === "") return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
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
