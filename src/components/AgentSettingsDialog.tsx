import { useEffect, useState } from "react";
import {
  X, Settings, ShieldCheck, ShieldAlert, AtSign, Save, AlertTriangle,
} from "lucide-react";
import { useStore } from "../store";
import { restartAgent } from "../lib/compact";
import { SAFETY_PROTOCOL } from "../lib/presets";
import { cn } from "../lib/cn";
import type { AgentSpec } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  agentId: string;
}

/// Edit a running agent's spec mid-conversation.
/// Saving triggers a kill + spawn (with the new spec) and replays the visible
/// chat history into the new pane via restartAgent — the agent itself starts
/// fresh with the new system prompt + toggles, but the user keeps their full
/// scrollback.
export function AgentSettingsDialog({ open, onClose, agentId }: Props) {
  const record = useStore((s) => s.agents[agentId]);

  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [requireApproval, setRequireApproval] = useState(true);
  const [allowMentions, setAllowMentions] = useState(true);
  const [allowlist, setAllowlist] = useState("");
  const [skipPerms, setSkipPerms] = useState(false);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !record) return;
    const s = record.snapshot.spec;
    setName(s.name);
    setRole(s.role);
    // Strip the appended SAFETY_PROTOCOL so the user only edits THEIR prompt.
    let prompt = s.system_prompt ?? "";
    if (prompt.includes(SAFETY_PROTOCOL.trimStart())) {
      prompt = prompt.replace(SAFETY_PROTOCOL.trimStart(), "").trimEnd();
    } else if (prompt.includes(SAFETY_PROTOCOL)) {
      prompt = prompt.replace(SAFETY_PROTOCOL, "").trimEnd();
    }
    setSystemPrompt(prompt);
    setAllowMentions(!!s.allow_mentions);
    setAllowlist((s.mention_allowlist ?? []).join(", "));
    // require_approval is implied if skip_permissions is on AND prompt contained the protocol
    const hadProtocol = (s.system_prompt ?? "").includes("USER APPROVAL PROTOCOL");
    setRequireApproval(hadProtocol);
    setSkipPerms(!hadProtocol && !!s.skip_permissions);
    setModel(s.model ?? "");
    setError(null);
  }, [open, record]);

  if (!open || !record) return null;

  const onSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const finalPrompt =
        (systemPrompt.trim() || "") + (requireApproval ? SAFETY_PROTOCOL : "");
      const effectiveSkipPerms = skipPerms || requireApproval;

      const newSpec: AgentSpec = {
        name: name.trim() || record.snapshot.spec.name,
        role: role.trim() || record.snapshot.spec.role,
        cwd: record.snapshot.spec.cwd, // not editable mid-convo
        system_prompt: finalPrompt || null,
        model: model.trim() || null,
        color: record.snapshot.spec.color,
        vendor: record.snapshot.spec.vendor ?? "claude",
        skip_permissions: effectiveSkipPerms,
        allow_mentions: allowMentions,
        mention_allowlist: allowlist
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
      await restartAgent(agentId, newSpec);
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const renamed = name.trim() && name.trim() !== record.snapshot.spec.name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-950/80 backdrop-blur-sm">
      <div className="glass rounded-xl w-[640px] max-w-[92vw] max-h-[88vh] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-base-800 flex items-center justify-between shrink-0">
          <div className="text-sm font-semibold tracking-wide flex items-center gap-2">
            <Settings size={14} className="text-(--color-accent-cyan)" />
            EDIT AGENT — @{record.snapshot.spec.name}
          </div>
          <button onClick={onClose} className="text-base-500 hover:text-base-200">
            <X size={16} />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-4">
          <div className="rounded-md border border-(--color-accent-amber)/40 bg-(--color-accent-amber)/5 p-2 text-[11px] text-(--color-accent-amber) flex items-start gap-2">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <div>
              Saving will <strong>kill the running agent process</strong> and
              spawn a fresh one with the new settings. Your visible chat
              history is preserved (replayed into the new pane), but the new
              process only sees its system prompt — turn-by-turn detail before
              this point is gone.
              {" "}
              <span className="block mt-1">
                Tip: pair this with /compact first if you want the agent to
                also remember a summary of what was discussed.
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Name (used as @mention)">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input"
              />
            </Field>
            <Field label="Model (override; blank = default)">
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="claude-sonnet-4-5"
                className="input font-mono text-xs"
              />
            </Field>
          </div>

          {renamed && (
            <div className="text-[11px] text-(--color-accent-amber) flex items-start gap-1.5">
              <AlertTriangle size={11} className="mt-0.5" />
              Renaming breaks any existing teammate's @mention to the old name.
              Other agents will only learn the new name on their next message
              (lazy roster injection).
            </div>
          )}

          <Field label="Role (free-form description)">
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="input"
            />
          </Field>

          <Field label="System prompt (the SAFETY_PROTOCOL block is auto-appended below if 'Require approval' is on)">
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={8}
              className="input font-mono text-xs"
            />
          </Field>

          <div className="rounded-md border border-base-700/60 bg-base-900/40 p-3 space-y-2">
            <div className="text-[10px] tracking-wider text-base-500 uppercase mb-1">
              Security
            </div>

            <ToggleRow
              checked={requireApproval}
              onChange={setRequireApproval}
              icon={<ShieldCheck size={12} />}
              label="Require user approval for destructive ops"
              hint="Adds the proposal protocol + implicitly enables --skip-permissions so tools work after Approve."
            />

            <ToggleRow
              checked={allowMentions}
              onChange={setAllowMentions}
              icon={<AtSign size={12} />}
              label="Allow this agent to mention others"
              hint="When ON, `@OtherAgent <msg>` in this agent's reply is forwarded by the host."
            />

            {allowMentions && (
              <Field label="Mention allowlist (comma-separated, empty = any)">
                <input
                  value={allowlist}
                  onChange={(e) => setAllowlist(e.target.value)}
                  placeholder="Architect, Backend, Frontend"
                  className="input text-xs"
                />
              </Field>
            )}

            {!requireApproval && (
              <ToggleRow
                checked={skipPerms}
                onChange={setSkipPerms}
                icon={<ShieldAlert size={12} />}
                danger
                label="Raw --dangerously-skip-permissions (no approval gate)"
                hint="DANGER: every Edit / Write / Bash call runs without asking. Prefer 'Require approval' above."
              />
            )}
            {requireApproval && (
              <div className="text-[10px] text-base-500 ml-6 -mt-1">
                (skip-permissions is implicitly ON; the approval cards in chat
                are what gate destructive actions.)
              </div>
            )}
          </div>

          {error && (
            <div className="text-xs text-(--color-accent-red) bg-(--color-accent-red)/10 border border-(--color-accent-red)/30 rounded-md px-2 py-1.5">
              {error}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-base-800 flex justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md hover:bg-base-800/60 text-base-400"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={busy || !name.trim()}
            className="px-4 py-1.5 text-sm rounded-md bg-(--color-accent-cyan)/20 hover:bg-(--color-accent-cyan)/30 border border-(--color-accent-cyan)/40 text-(--color-accent-cyan) disabled:opacity-40 flex items-center gap-1.5"
          >
            <Save size={12} /> {busy ? "Restarting…" : "Save & Restart"}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] tracking-wider text-base-500 mb-1 uppercase">{label}</div>
      {children}
    </div>
  );
}

function ToggleRow({
  checked, onChange, icon, label, hint, danger,
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
