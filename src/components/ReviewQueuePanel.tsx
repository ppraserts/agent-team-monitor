import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  GitPullRequest,
  Loader2,
  ShieldCheck,
  ThumbsUp,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { PRESETS, SAFETY_PROTOCOL, findPreset } from "../lib/presets";
import {
  buildReviewerPrompt,
  evaluateReviewPolicy,
  parseBitbucketPr,
  parseChangedFiles,
} from "../lib/prReview";
import { useStore } from "../store";

interface Props {
  cwd: string;
  onClose: () => void;
}

export function ReviewQueuePanel({ cwd, onClose }: Props) {
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const upsertAgent = useStore((s) => s.upsertAgent);
  const [slackText, setSlackText] = useState("");
  const [changedFilesText, setChangedFilesText] = useState("");
  const [busy, setBusy] = useState(false);
  const [fetchBusy, setFetchBusy] = useState(false);
  const [approveBusy, setApproveBusy] = useState(false);
  const [localMessage, setLocalMessage] = useState("");
  const [fetchedTitle, setFetchedTitle] = useState("");
  const [fetchedMeta, setFetchedMeta] = useState("");

  const pr = useMemo(() => parseBitbucketPr(slackText), [slackText]);
  const changedFiles = useMemo(() => parseChangedFiles(changedFilesText), [changedFilesText]);
  const policy = useMemo(
    () => evaluateReviewPolicy({ pr, changedFiles, notes: `${slackText}\n${changedFilesText}` }),
    [changedFiles, pr, slackText, changedFilesText],
  );
  const reviewerPrompt = useMemo(
    () => buildReviewerPrompt({ pr, slackText, changedFiles, policy }),
    [changedFiles, policy, pr, slackText],
  );

  useEffect(() => {
    setFetchedTitle("");
    setFetchedMeta("");
  }, [pr?.url]);

  const spawnReviewer = async () => {
    setBusy(true);
    setLocalMessage("");
    try {
      const preset = findPreset("Reviewer") ?? PRESETS[0];
      const settings = await api.settingsGetAll().catch(() => ({} as Record<string, string>));
      const snap = await api.spawnAgent({
        name: nextReviewerName(),
        role: "PR review gate",
        cwd,
        system_prompt: `${preset.system_prompt}${SAFETY_PROTOCOL}`,
        model: null,
        color: preset.color,
        vendor: "claude",
        vendor_binary: settings.default_claude_bin || null,
        workspace_id: activeWorkspace?.id ?? null,
        skip_permissions: settings.default_skip_perms === "true",
        allow_mentions: settings.default_allow_mentions !== "false",
        mention_allowlist: [],
      });
      upsertAgent(snap);
      await api.sendAgent(snap.id, reviewerPrompt);
      setLocalMessage(`Spawned @${snap.spec.name} and sent the PR review brief.`);
    } catch (err) {
      setLocalMessage(`Spawn reviewer failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(reviewerPrompt);
    setLocalMessage("Review prompt copied.");
  };

  const fetchFromBitbucket = async () => {
    if (!pr) return;
    setFetchBusy(true);
    setLocalMessage("");
    try {
      const info = await api.bitbucketPrFetch(pr.url);
      setChangedFilesText(info.changedFiles.join("\n"));
      setFetchedTitle(info.title);
      setFetchedMeta(
        [
          `${info.author} opened ${info.sourceBranch} -> ${info.destinationBranch}`,
          `state=${info.state}`,
          info.sourceCommit ? `commit=${info.sourceCommit.slice(0, 12)}` : "",
          info.hasMoreFiles ? "diffstat truncated after 10 pages" : "",
        ]
          .filter(Boolean)
          .join(" | "),
      );
      setLocalMessage(`Fetched ${info.changedFiles.length} changed file(s) from Bitbucket.`);
    } catch (err) {
      setLocalMessage(`Fetch failed: ${err}`);
    } finally {
      setFetchBusy(false);
    }
  };

  const approveOnBitbucket = async () => {
    if (!pr || policy.decision !== "ready") return;
    const ok = window.confirm(
      `Approve ${pr.workspace}/${pr.repo} PR #${pr.prId} on Bitbucket? This changes the PR review state.`,
    );
    if (!ok) return;
    setApproveBusy(true);
    setLocalMessage("");
    try {
      await api.bitbucketPrApprove(pr.url);
      setLocalMessage("Approved this PR on Bitbucket.");
    } catch (err) {
      setLocalMessage(`Approve failed: ${err}`);
    } finally {
      setApproveBusy(false);
    }
  };

  return (
    <div className="h-full rounded-lg border border-base-800 bg-base-950/70 overflow-hidden flex flex-col">
      <div className="h-10 px-3 border-b border-base-800 bg-base-900/80 flex items-center gap-2 shrink-0">
        <GitPullRequest size={15} className="text-(--color-accent-cyan)" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">PR Review Queue</div>
          <div className="text-[10px] text-base-500 truncate">Slack to Bitbucket review gate</div>
        </div>
        <button
          onClick={onClose}
          className="h-7 w-7 rounded-md text-base-500 hover:text-base-100 hover:bg-base-800 flex items-center justify-center"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        <section className="space-y-2">
          <Label>Slack message or Bitbucket PR URL</Label>
          <textarea
            value={slackText}
            onChange={(e) => setSlackText(e.target.value)}
            placeholder="Paste Slack text with https://bitbucket.org/.../pull-requests/123"
            rows={4}
            className="input-area"
          />
          {pr ? (
            <PrCard
              workspace={pr.workspace}
              repo={pr.repo}
              prId={pr.prId}
              url={pr.url}
              title={fetchedTitle}
              meta={fetchedMeta}
            />
          ) : (
            <Hint tone="warn">Paste a Bitbucket pull request link to create a review item.</Hint>
          )}
        </section>

        <section className="space-y-2">
          <Label>Changed files</Label>
          <textarea
            value={changedFilesText}
            onChange={(e) => setChangedFilesText(e.target.value)}
            placeholder={"Paste changed files from Bitbucket, one per line.\nExample:\nsrc/components/Button.tsx\nREADME.md"}
            rows={7}
            className="input-area font-mono"
          />
        </section>

        <PolicyCard decision={policy.decision} blockers={policy.blockers} warnings={policy.warnings} />

        <section className="rounded-md border border-base-800 bg-base-900/50 p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-base-500">Next action</div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={fetchFromBitbucket}
              disabled={fetchBusy || !pr}
              className="h-9 rounded-md border border-base-700 bg-base-800/50 text-base-200 hover:bg-base-700/60 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-xs"
            >
              {fetchBusy ? <Loader2 size={13} className="animate-spin" /> : <GitPullRequest size={13} />}
              Fetch PR
            </button>
            <button
              onClick={approveOnBitbucket}
              disabled={approveBusy || !pr || policy.decision !== "ready"}
              className="h-9 rounded-md border border-(--color-accent-green)/35 bg-(--color-accent-green)/10 text-(--color-accent-green) hover:bg-(--color-accent-green)/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-xs"
            >
              {approveBusy ? <Loader2 size={13} className="animate-spin" /> : <ThumbsUp size={13} />}
              Approve
            </button>
            <button
              onClick={spawnReviewer}
              disabled={busy || !pr}
              className="h-9 rounded-md border border-(--color-accent-cyan)/35 bg-(--color-accent-cyan)/10 text-(--color-accent-cyan) hover:bg-(--color-accent-cyan)/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-xs"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
              Agent review
            </button>
            <button
              onClick={copyPrompt}
              disabled={!pr}
              className="h-9 rounded-md border border-base-700 bg-base-800/50 text-base-200 hover:bg-base-700/60 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-xs"
            >
              <Clipboard size={13} />
              Copy brief
            </button>
          </div>
          {localMessage && (
            <div className="text-[11px] text-base-400 font-mono border-l-2 border-base-700 pl-2">
              {localMessage}
            </div>
          )}
        </section>
      </div>

      <style>{`
        .input-area {
          width: 100%;
          resize: vertical;
          min-height: 72px;
          border-radius: 6px;
          border: 1px solid var(--color-base-700);
          background: var(--color-base-950);
          color: var(--color-base-200);
          padding: 8px 10px;
          font-size: 12px;
          outline: none;
        }
        .input-area:focus {
          border-color: color-mix(in oklch, var(--color-accent-cyan) 50%, transparent);
        }
      `}</style>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-wider text-base-500">{children}</div>;
}

function Hint({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1.5 text-[11px]",
        tone === "warn"
          ? "border-(--color-accent-amber)/35 bg-(--color-accent-amber)/10 text-(--color-accent-amber)"
          : "border-base-800 bg-base-900/50 text-base-400",
      )}
    >
      {children}
    </div>
  );
}

function PrCard({
  workspace,
  repo,
  prId,
  url,
  title,
  meta,
}: {
  workspace: string;
  repo: string;
  prId: number;
  url: string;
  title?: string;
  meta?: string;
}) {
  return (
    <div className="rounded-md border border-base-800 bg-base-900/50 p-2 flex items-center gap-2">
      <GitPullRequest size={14} className="text-(--color-accent-cyan) shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium truncate">
          {title || `${workspace}/${repo} #${prId}`}
        </div>
        <div className="text-[10px] text-base-500 truncate">
          {meta || `${workspace}/${repo} #${prId}`}
        </div>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="h-7 w-7 rounded-md text-base-500 hover:text-base-100 hover:bg-base-800 flex items-center justify-center"
        title="Open PR"
      >
        <ExternalLink size={13} />
      </a>
    </div>
  );
}

function PolicyCard({
  decision,
  blockers,
  warnings,
}: {
  decision: "ready" | "needs-review" | "incomplete";
  blockers: string[];
  warnings: string[];
}) {
  const ready = decision === "ready";
  const incomplete = decision === "incomplete";
  return (
    <section
      className={cn(
        "rounded-md border p-3 space-y-2",
        ready
          ? "border-(--color-accent-green)/35 bg-(--color-accent-green)/10"
          : incomplete
            ? "border-(--color-accent-amber)/35 bg-(--color-accent-amber)/10"
            : "border-(--color-accent-red)/35 bg-(--color-accent-red)/10",
      )}
    >
      <div className="flex items-center gap-2">
        {ready ? (
          <CheckCircle2 size={15} className="text-(--color-accent-green)" />
        ) : (
          <AlertTriangle
            size={15}
            className={incomplete ? "text-(--color-accent-amber)" : "text-(--color-accent-red)"}
          />
        )}
        <div className="text-sm font-semibold">
          {ready ? "Auto candidate" : incomplete ? "Needs PR metadata" : "Needs manual review"}
        </div>
      </div>
      {blockers.map((item) => (
        <div key={item} className="text-[11px] text-(--color-accent-red) font-mono">
          {item}
        </div>
      ))}
      {warnings.map((item) => (
        <div key={item} className="text-[11px] text-(--color-accent-amber) font-mono">
          {item}
        </div>
      ))}
      {ready && (
        <div className="text-[11px] text-base-400">
          This is eligible for one-click approval once Bitbucket status checks and diff fetch are connected.
        </div>
      )}
    </section>
  );
}

function nextReviewerName(): string {
  const agents = Object.values(useStore.getState().agents);
  const names = new Set(agents.map((a) => a.snapshot.spec.name));
  if (!names.has("PRReviewer")) return "PRReviewer";
  let i = 2;
  while (names.has(`PRReviewer${i}`)) i += 1;
  return `PRReviewer${i}`;
}
