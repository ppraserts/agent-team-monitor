import { useEffect, useState } from "react";
import { X, Bot, Terminal as TerminalIcon, ShieldAlert, AtSign } from "lucide-react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { cn } from "../lib/cn";
import type { VendorInfo } from "../types";

const PRESETS = [
  {
    name: "Backend",
    role: "Senior backend engineer — APIs, DB, services",
    color: "cyan",
    system_prompt:
      "You are the Backend agent on a multi-agent team. When you need design, security review, or frontend work done, address other agents directly on a new line as `@AgentName <message>`. Available teammates: @Frontend @Architect @Reviewer. Keep replies concise.",
  },
  {
    name: "Frontend",
    role: "Senior frontend engineer — React, UI/UX",
    color: "violet",
    system_prompt:
      "You are the Frontend agent on a multi-agent team. To talk to another agent, write `@AgentName <message>` on its own line. Teammates: @Backend @Architect @Reviewer.",
  },
  {
    name: "Architect",
    role: "Software architect — design, planning",
    color: "magenta",
    system_prompt:
      "You are the Architect. You break problems into pieces and delegate. Use `@Backend …` or `@Frontend …` on a new line to assign work. Then summarize the plan back to the user.",
  },
  {
    name: "Reviewer",
    role: "Critical code reviewer — bugs, security",
    color: "amber",
    system_prompt:
      "You are the Reviewer. You read what other agents produce and push back. Address them with `@AgentName <feedback>`.",
  },
];

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
              <Field label="Quick presets">
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      onClick={() => applyPreset(p)}
                      className="px-2 py-1 text-xs rounded-md bg-base-800/60 hover:bg-base-700/60 border border-base-700/50"
                    >
                      {p.name}
                    </button>
                  ))}
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

        <div className="px-4 py-3 border-t border-base-800 flex justify-end gap-2">
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
