export interface BitbucketPrRef {
  url: string;
  workspace: string;
  repo: string;
  prId: number;
}

export type ReviewDecision = "ready" | "needs-review" | "incomplete";

export interface ReviewPolicyResult {
  decision: ReviewDecision;
  blockers: string[];
  warnings: string[];
  safeFiles: string[];
}

const BITBUCKET_PR_RE =
  /https:\/\/bitbucket\.org\/([^/\s]+)\/([^/\s]+)\/pull-requests\/(\d+)(?:[/?#][^\s]*)?/i;

const LOCK_OR_PACKAGE_RE =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock)$/i;

const HIGH_RISK_PATH_RE =
  /(^|\/)(\.env|\.npmrc|\.yarnrc|Dockerfile|docker-compose\.ya?ml|bitbucket-pipelines\.ya?ml|\.github\/workflows\/|infra\/|terraform\/|k8s\/|helm\/|migrations\/)/i;

const CONFLICT_RE = /(<<<<<<<|=======|>>>>>>>|merge conflict|conflict)/i;

export function parseBitbucketPr(text: string): BitbucketPrRef | null {
  const match = text.match(BITBUCKET_PR_RE);
  if (!match) return null;
  return {
    url: match[0],
    workspace: match[1],
    repo: match[2],
    prId: Number(match[3]),
  };
}

export function parseChangedFiles(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, ""))
    .map((line) => line.replace(/^\w+\s+/, ""))
    .filter((line) => !line.startsWith("http"))
    .filter((line, index, arr) => arr.indexOf(line) === index);
}

export function evaluateReviewPolicy(input: {
  pr: BitbucketPrRef | null;
  changedFiles: string[];
  notes: string;
}): ReviewPolicyResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!input.pr) {
    blockers.push("No Bitbucket pull request URL found.");
  }

  if (CONFLICT_RE.test(input.notes)) {
    blockers.push("Conflict marker or conflict wording was found in the pasted text.");
  }

  if (input.changedFiles.length === 0) {
    warnings.push("No changed-file list provided yet. Fetch this from Bitbucket before any auto approval.");
  }

  for (const file of input.changedFiles) {
    if (LOCK_OR_PACKAGE_RE.test(file)) {
      blockers.push(`Package or lock file changed: ${file}`);
    } else if (HIGH_RISK_PATH_RE.test(file)) {
      blockers.push(`High-risk path changed: ${file}`);
    }
  }

  if (input.changedFiles.length > 25) {
    warnings.push(`Large PR: ${input.changedFiles.length} files changed.`);
  }

  const safeFiles = input.changedFiles.filter(
    (file) => !LOCK_OR_PACKAGE_RE.test(file) && !HIGH_RISK_PATH_RE.test(file),
  );

  const decision: ReviewDecision =
    blockers.length > 0
      ? "needs-review"
      : input.changedFiles.length === 0
        ? "incomplete"
        : "ready";

  return { decision, blockers, warnings, safeFiles };
}

export function buildReviewerPrompt(input: {
  pr: BitbucketPrRef | null;
  slackText: string;
  changedFiles: string[];
  policy: ReviewPolicyResult;
}): string {
  const prLine = input.pr
    ? `${input.pr.workspace}/${input.pr.repo} PR #${input.pr.prId}: ${input.pr.url}`
    : "No PR URL parsed.";
  return [
    "Review this Bitbucket pull request for approval readiness.",
    "",
    prLine,
    "",
    "Policy:",
    "- Do not approve if package manifests, lock files, conflicts, infra, secret/config, pipeline, or migration files changed.",
    "- If the PR is low-risk, summarize why it is safe.",
    "- If not safe, list concrete blockers and what I should inspect manually.",
    "",
    "Changed files:",
    input.changedFiles.length > 0 ? input.changedFiles.map((file) => `- ${file}`).join("\n") : "- Not provided",
    "",
    "Current policy result:",
    `Decision: ${input.policy.decision}`,
    ...input.policy.blockers.map((b) => `Blocker: ${b}`),
    ...input.policy.warnings.map((w) => `Warning: ${w}`),
    "",
    "Original Slack text:",
    input.slackText.trim() || "(empty)",
  ].join("\n");
}
