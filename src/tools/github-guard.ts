import { loadGithubConfig, normalizeRepoAllowEntry } from "../config/github-config";
import { getGithubAuthToken } from "../config/github-env";
import type { WorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";

const MAX_COMMENT_OR_ISSUE_BODY = 65_536;
const MAX_ISSUE_TITLE = 256;

export function isGithubToolName(toolName: string): boolean {
  return toolName.startsWith("github.");
}

export function normalizeGithubRepoInput(
  input: unknown,
  defaultOwner?: string
): { owner: string; repo: string } | null {
  if (typeof input !== "object" || input === null || !("repo" in input)) return null;
  const repoRaw = (input as { repo: unknown }).repo;
  if (typeof repoRaw !== "string") return null;
  const repoTrim = repoRaw.trim();
  let owner: string | undefined =
    typeof (input as { owner?: unknown }).owner === "string" ? (input as { owner: string }).owner.trim() : undefined;
  let repo = repoTrim;

  if (repo.includes("/")) {
    const parts = repo.split("/").filter(Boolean);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    if (owner && owner !== parts[0]) return null;
    owner = parts[0];
    repo = parts[1];
  }

  if (!owner) {
    owner = defaultOwner?.trim();
  }
  if (!owner || !repo) return null;
  if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo };
}

function effectiveGithubAllowlist(
  policy: WorkspacePolicy,
  configReposAllow: string[] | undefined
): { allow: Set<string> | null; error?: string } {
  const policyAllow = policy.github_repos_allow?.map(normalizeRepoAllowEntry);
  const configAllow = configReposAllow?.map(normalizeRepoAllowEntry);

  if (policyAllow?.length && configAllow?.length) {
    const cSet = new Set(configAllow);
    const inter = policyAllow.filter((r) => cSet.has(r));
    if (inter.length === 0) {
      return { allow: null, error: "github_repos_allow and github.yaml repos_allow have empty intersection" };
    }
    return { allow: new Set(inter) };
  }
  if (policyAllow?.length) {
    return { allow: new Set(policyAllow) };
  }
  if (configAllow?.length) {
    return { allow: new Set(configAllow) };
  }
  return { allow: null };
}

export async function classifyGithubInputSafety(
  toolName: string,
  input: unknown,
  ctx: { rootDir: string; policy: WorkspacePolicy }
): Promise<{ ok: boolean; reason?: string }> {
  if (!isGithubToolName(toolName)) {
    return { ok: true };
  }

  if (ctx.policy.github === "block") {
    return { ok: false, reason: "GitHub tools are blocked by policy (github: block)." };
  }

  const paths = resolveWorkspacePaths(ctx.rootDir);
  const ghCfg = await loadGithubConfig(paths.githubFile);
  if (!ghCfg.ok) {
    return { ok: false, reason: `github.yaml invalid: ${ghCfg.message}` };
  }

  const norm = normalizeGithubRepoInput(input, ghCfg.value.defaultOwner);
  if (!norm) {
    return {
      ok: false,
      reason:
        "Invalid or missing GitHub repo: use owner + repo, or repo as owner/name, or set defaultOwner in github.yaml"
    };
  }

  const ref = `${norm.owner}/${norm.repo}`.toLowerCase();
  const { allow, error } = effectiveGithubAllowlist(ctx.policy, ghCfg.value.repos_allow);
  if (error) {
    return { ok: false, reason: error };
  }
  if (allow && !allow.has(ref)) {
    return { ok: false, reason: `Repository ${ref} is not in the effective allowlist` };
  }

  if (!getGithubAuthToken()) {
    return { ok: false, reason: "GITHUB_TOKEN or GH_TOKEN is not set" };
  }

  if (typeof input === "object" && input !== null) {
    if ("body" in input && typeof (input as { body: unknown }).body === "string") {
      const b = (input as { body: string }).body;
      if (b.length > MAX_COMMENT_OR_ISSUE_BODY) {
        return { ok: false, reason: `body exceeds max length (${MAX_COMMENT_OR_ISSUE_BODY})` };
      }
    }
    if ("title" in input && typeof (input as { title: unknown }).title === "string") {
      const t = (input as { title: string }).title;
      if (t.length > MAX_ISSUE_TITLE) {
        return { ok: false, reason: `title exceeds max length (${MAX_ISSUE_TITLE})` };
      }
    }
  }

  return { ok: true };
}
