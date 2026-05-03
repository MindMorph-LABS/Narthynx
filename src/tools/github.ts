import { z } from "zod";

import { loadGithubConfig } from "../config/github-config";
import { resolveWorkspacePaths } from "../config/workspace";
import { createArtifactStore, writeOutputArtifact } from "../missions/artifacts";
import { createOctokitForWorkspace, formatGithubRequestError } from "./github-client";
import { normalizeGithubRepoInput } from "./github-guard";
import type { ToolAction } from "./types";

const ghRepoInputSchema = z.object({
  owner: z.string().min(1).optional(),
  repo: z.string().min(1)
});

const githubJsonOutputSchema = z.object({
  data: z.unknown(),
  artifactPath: z.string().optional(),
  truncated: z.boolean(),
  resultBytes: z.number().int().nonnegative()
});

const issuesListInputSchema = ghRepoInputSchema.extend({
  state: z.enum(["open", "closed", "all"]).default("open"),
  per_page: z.number().int().min(1).max(100).default(30),
  page: z.number().int().min(1).max(50).default(1)
});

const issueNumberInputSchema = ghRepoInputSchema.extend({
  issue_number: z.number().int().min(1)
});

const pullsListInputSchema = ghRepoInputSchema.extend({
  state: z.enum(["open", "closed", "all"]).default("open"),
  per_page: z.number().int().min(1).max(100).default(30),
  page: z.number().int().min(1).max(50).default(1)
});

const pullNumberInputSchema = ghRepoInputSchema.extend({
  pull_number: z.number().int().min(1)
});

const issueCreateInputSchema = ghRepoInputSchema.extend({
  title: z.string().min(1).max(256),
  body: z.string().max(65_536).optional()
});

const issueCommentInputSchema = ghRepoInputSchema.extend({
  issue_number: z.number().int().min(1),
  body: z.string().min(1).max(65_536)
});

async function resolveRepo(cwd: string, input: { owner?: string; repo: string }) {
  const paths = resolveWorkspacePaths(cwd);
  const gh = await loadGithubConfig(paths.githubFile);
  if (!gh.ok) {
    throw new Error(`github.yaml invalid: ${gh.message}`);
  }
  const norm = normalizeGithubRepoInput(input, gh.value.defaultOwner);
  if (!norm) {
    throw new Error("Invalid or missing owner/repo for GitHub tool");
  }
  return norm;
}

async function spillOrInlineGithubJson(
  cwd: string,
  missionId: string,
  toolName: string,
  payload: unknown,
  maxBytes: number
): Promise<{ data: unknown; artifactPath?: string; truncated: boolean; resultBytes: number }> {
  const json = JSON.stringify(payload, null, 2);
  const resultBytes = Buffer.byteLength(json, "utf8");
  if (resultBytes <= maxBytes) {
    return { data: payload, truncated: false, resultBytes };
  }

  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = `github-${toolName.replace(/\./g, "-")}-${now}.json`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const written = await writeOutputArtifact(cwd, missionId, safeName, json);
  await createArtifactStore(cwd).registerArtifact({
    missionId,
    type: "github_api_response",
    title: `GitHub ${toolName}`,
    relativePath: written.relativePath,
    metadata: { toolName, resultBytes }
  });

  return {
    data: {
      _spillover: true,
      message: "Response exceeded maxResponseBytes; full JSON is in the artifact",
      artifactPath: written.relativePath
    },
    artifactPath: written.relativePath,
    truncated: true,
    resultBytes
  };
}

export const githubTools: ToolAction<unknown, unknown>[] = [
  {
    name: "github.repos.get",
    description: "Get repository metadata from the GitHub API (REST).",
    inputSchema: ghRepoInputSchema,
    outputSchema: githubJsonOutputSchema,
    riskLevel: "low",
    sideEffect: "external_comm",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const parsed = ghRepoInputSchema.parse(input);
      const repo = await resolveRepo(context.cwd, parsed);
      const client = await createOctokitForWorkspace(context.cwd);
      if (!client.ok) {
        throw new Error(client.message);
      }
      const signal = AbortSignal.timeout(client.timeoutMs);
      try {
        const { data } = await client.octokit.rest.repos.get({
          owner: repo.owner,
          repo: repo.repo,
          request: { signal }
        });
        return spillOrInlineGithubJson(context.cwd, context.missionId, "github.repos.get", data, client.maxResponseBytes);
      } catch (e) {
        throw new Error(formatGithubRequestError(e));
      }
    }
  },
  {
    name: "github.issues.get",
    description: "Get a single issue by number.",
    inputSchema: issueNumberInputSchema,
    outputSchema: githubJsonOutputSchema,
    riskLevel: "low",
    sideEffect: "external_comm",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const parsed = issueNumberInputSchema.parse(input);
      const repo = await resolveRepo(context.cwd, parsed);
      const client = await createOctokitForWorkspace(context.cwd);
      if (!client.ok) {
        throw new Error(client.message);
      }
      const signal = AbortSignal.timeout(client.timeoutMs);
      try {
        const { data } = await client.octokit.rest.issues.get({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: parsed.issue_number,
          request: { signal }
        });
        return spillOrInlineGithubJson(context.cwd, context.missionId, "github.issues.get", data, client.maxResponseBytes);
      } catch (e) {
        throw new Error(formatGithubRequestError(e));
      }
    }
  },
  {
    name: "github.issues.list",
    description: "List issues for a repository (paginated).",
    inputSchema: issuesListInputSchema,
    outputSchema: githubJsonOutputSchema,
    riskLevel: "low",
    sideEffect: "external_comm",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const parsed = issuesListInputSchema.parse(input);
      const repo = await resolveRepo(context.cwd, parsed);
      const client = await createOctokitForWorkspace(context.cwd);
      if (!client.ok) {
        throw new Error(client.message);
      }
      const signal = AbortSignal.timeout(client.timeoutMs);
      try {
        const { data } = await client.octokit.rest.issues.listForRepo({
          owner: repo.owner,
          repo: repo.repo,
          state: parsed.state,
          per_page: parsed.per_page,
          page: parsed.page,
          request: { signal }
        });
        return spillOrInlineGithubJson(context.cwd, context.missionId, "github.issues.list", data, client.maxResponseBytes);
      } catch (e) {
        throw new Error(formatGithubRequestError(e));
      }
    }
  },
  {
    name: "github.issues.listComments",
    description: "List comments on an issue.",
    inputSchema: issueNumberInputSchema.extend({
      per_page: z.number().int().min(1).max(100).default(30),
      page: z.number().int().min(1).max(50).default(1)
    }),
    outputSchema: githubJsonOutputSchema,
    riskLevel: "low",
    sideEffect: "external_comm",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const schema = issueNumberInputSchema.extend({
        per_page: z.number().int().min(1).max(100).default(30),
        page: z.number().int().min(1).max(50).default(1)
      });
      const parsed = schema.parse(input);
      const repo = await resolveRepo(context.cwd, parsed);
      const client = await createOctokitForWorkspace(context.cwd);
      if (!client.ok) {
        throw new Error(client.message);
      }
      const signal = AbortSignal.timeout(client.timeoutMs);
      try {
        const { data } = await client.octokit.rest.issues.listComments({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: parsed.issue_number,
          per_page: parsed.per_page,
          page: parsed.page,
          request: { signal }
        });
        return spillOrInlineGithubJson(
          context.cwd,
          context.missionId,
          "github.issues.listComments",
          data,
          client.maxResponseBytes
        );
      } catch (e) {
        throw new Error(formatGithubRequestError(e));
      }
    }
  },
  {
    name: "github.pulls.get",
    description: "Get a single pull request by number.",
    inputSchema: pullNumberInputSchema,
    outputSchema: githubJsonOutputSchema,
    riskLevel: "low",
    sideEffect: "external_comm",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const parsed = pullNumberInputSchema.parse(input);
      const repo = await resolveRepo(context.cwd, parsed);
      const client = await createOctokitForWorkspace(context.cwd);
      if (!client.ok) {
        throw new Error(client.message);
      }
      const signal = AbortSignal.timeout(client.timeoutMs);
      try {
        const { data } = await client.octokit.rest.pulls.get({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: parsed.pull_number,
          request: { signal }
        });
        return spillOrInlineGithubJson(context.cwd, context.missionId, "github.pulls.get", data, client.maxResponseBytes);
      } catch (e) {
        throw new Error(formatGithubRequestError(e));
      }
    }
  },
  {
    name: "github.pulls.list",
    description: "List pull requests for a repository.",
    inputSchema: pullsListInputSchema,
    outputSchema: githubJsonOutputSchema,
    riskLevel: "low",
    sideEffect: "external_comm",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const parsed = pullsListInputSchema.parse(input);
      const repo = await resolveRepo(context.cwd, parsed);
      const client = await createOctokitForWorkspace(context.cwd);
      if (!client.ok) {
        throw new Error(client.message);
      }
      const signal = AbortSignal.timeout(client.timeoutMs);
      try {
        const { data } = await client.octokit.rest.pulls.list({
          owner: repo.owner,
          repo: repo.repo,
          state: parsed.state,
          per_page: parsed.per_page,
          page: parsed.page,
          request: { signal }
        });
        return spillOrInlineGithubJson(context.cwd, context.missionId, "github.pulls.list", data, client.maxResponseBytes);
      } catch (e) {
        throw new Error(formatGithubRequestError(e));
      }
    }
  },
  {
    name: "github.pulls.listFiles",
    description: "List files changed in a pull request.",
    inputSchema: pullNumberInputSchema.extend({
      per_page: z.number().int().min(1).max(100).default(30),
      page: z.number().int().min(1).max(50).default(1)
    }),
    outputSchema: githubJsonOutputSchema,
    riskLevel: "medium",
    sideEffect: "external_comm",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const schema = pullNumberInputSchema.extend({
        per_page: z.number().int().min(1).max(100).default(30),
        page: z.number().int().min(1).max(50).default(1)
      });
      const parsed = schema.parse(input);
      const repo = await resolveRepo(context.cwd, parsed);
      const client = await createOctokitForWorkspace(context.cwd);
      if (!client.ok) {
        throw new Error(client.message);
      }
      const signal = AbortSignal.timeout(client.timeoutMs);
      try {
        const { data } = await client.octokit.rest.pulls.listFiles({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: parsed.pull_number,
          per_page: parsed.per_page,
          page: parsed.page,
          request: { signal }
        });
        return spillOrInlineGithubJson(
          context.cwd,
          context.missionId,
          "github.pulls.listFiles",
          data,
          client.maxResponseBytes
        );
      } catch (e) {
        throw new Error(formatGithubRequestError(e));
      }
    }
  },
  {
    name: "github.issues.create",
    description: "Create a new issue (mutating; requires approval under default policy).",
    inputSchema: issueCreateInputSchema,
    outputSchema: githubJsonOutputSchema,
    riskLevel: "high",
    sideEffect: "external_comm",
    requiresApproval: true,
    reversible: false,
    async run(input, context) {
      const parsed = issueCreateInputSchema.parse(input);
      const repo = await resolveRepo(context.cwd, parsed);
      const client = await createOctokitForWorkspace(context.cwd);
      if (!client.ok) {
        throw new Error(client.message);
      }
      const signal = AbortSignal.timeout(client.timeoutMs);
      try {
        const { data } = await client.octokit.rest.issues.create({
          owner: repo.owner,
          repo: repo.repo,
          title: parsed.title,
          body: parsed.body,
          request: { signal }
        });
        return spillOrInlineGithubJson(context.cwd, context.missionId, "github.issues.create", data, client.maxResponseBytes);
      } catch (e) {
        throw new Error(formatGithubRequestError(e));
      }
    }
  },
  {
    name: "github.issues.createComment",
    description: "Create a comment on an issue (mutating; requires approval under default policy).",
    inputSchema: issueCommentInputSchema,
    outputSchema: githubJsonOutputSchema,
    riskLevel: "high",
    sideEffect: "external_comm",
    requiresApproval: true,
    reversible: false,
    async run(input, context) {
      const parsed = issueCommentInputSchema.parse(input);
      const repo = await resolveRepo(context.cwd, parsed);
      const client = await createOctokitForWorkspace(context.cwd);
      if (!client.ok) {
        throw new Error(client.message);
      }
      const signal = AbortSignal.timeout(client.timeoutMs);
      try {
        const { data } = await client.octokit.rest.issues.createComment({
          owner: repo.owner,
          repo: repo.repo,
          issue_number: parsed.issue_number,
          body: parsed.body,
          request: { signal }
        });
        return spillOrInlineGithubJson(
          context.cwd,
          context.missionId,
          "github.issues.createComment",
          data,
          client.maxResponseBytes
        );
      } catch (e) {
        throw new Error(formatGithubRequestError(e));
      }
    }
  }
];
