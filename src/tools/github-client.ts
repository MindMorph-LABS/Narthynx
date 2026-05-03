import { Octokit } from "@octokit/rest";

import { defaultGithubConfigValues, loadGithubConfig } from "../config/github-config";
import { getGithubAuthToken } from "../config/github-env";
import { resolveWorkspacePaths } from "../config/workspace";

export function formatGithubRequestError(err: unknown): string {
  if (err && typeof err === "object" && "status" in err) {
    const o = err as { status?: number; message?: string };
    const msg = typeof o.message === "string" ? o.message : "GitHub API error";
    if (o.status === 403) {
      return `GitHub API 403: ${msg} (check scopes or rate limit)`;
    }
    return `GitHub API ${o.status ?? "?"}: ${msg}`;
  }
  return err instanceof Error ? err.message : "Unknown GitHub client error";
}

export async function createOctokitForWorkspace(cwd: string): Promise<
  | {
      ok: true;
      octokit: Octokit;
      timeoutMs: number;
      maxResponseBytes: number;
    }
  | { ok: false; message: string }
> {
  const paths = resolveWorkspacePaths(cwd);
  const cfg = await loadGithubConfig(paths.githubFile);
  if (!cfg.ok) {
    return { ok: false, message: cfg.message };
  }

  const token = getGithubAuthToken();
  if (!token) {
    return { ok: false, message: "GITHUB_TOKEN or GH_TOKEN is not set" };
  }

  const timeoutMs = cfg.value.timeoutMs ?? defaultGithubConfigValues.timeoutMs;
  const maxResponseBytes = cfg.value.maxResponseBytes ?? defaultGithubConfigValues.maxResponseBytes;

  const rawBase = cfg.value.baseUrl?.replace(/\/$/, "");
  const octokit = new Octokit({
    auth: token,
    baseUrl: rawBase && rawBase !== "https://api.github.com" ? rawBase : undefined
  });

  return { ok: true, octokit, timeoutMs, maxResponseBytes };
}
