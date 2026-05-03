import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CONFIG_FILE_NAME,
  CONTEXT_DIET_FILE_NAME,
  GITHUB_FILE_NAME,
  MCP_FILE_NAME,
  MISSIONS_DIR_NAME,
  POLICY_FILE_NAME,
  WORKSPACE_DIR_NAME,
  defaultConfigYaml,
  defaultPolicyYaml
} from "./defaults";
import { IDENTITY_FILE_NAME, loadWorkspaceIdentityFile } from "./identity-config";
import { loadContextDietConfig } from "./context-diet-config";
import { loadGithubConfig, normalizeRepoAllowEntry } from "./github-config";
import { getGithubAuthToken } from "./github-env";
import { findMcpServer, loadMcpConfig } from "./mcp-config";
import { loadModelRoutingConfig, MODEL_ROUTING_FILE_NAME } from "./model-routing-config";
import { loadWorkspaceConfig, loadWorkspacePolicy } from "./load";

export interface WorkspacePaths {
  rootDir: string;
  workspaceDir: string;
  configFile: string;
  policyFile: string;
  identityFile: string;
  contextDietFile: string;
  modelRoutingFile: string;
  mcpFile: string;
  githubFile: string;
  mcpCacheDir: string;
  missionsDir: string;
}

export interface WorkspaceInitResult {
  paths: WorkspacePaths;
  created: string[];
  preserved: string[];
  failed: string[];
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface DoctorResult {
  ok: boolean;
  paths: WorkspacePaths;
  checks: DoctorCheck[];
}

export function resolveWorkspacePaths(cwd = process.cwd()): WorkspacePaths {
  const rootDir = path.resolve(cwd);
  const workspaceDir = path.join(rootDir, WORKSPACE_DIR_NAME);

  return {
    rootDir,
    workspaceDir,
    configFile: path.join(workspaceDir, CONFIG_FILE_NAME),
    policyFile: path.join(workspaceDir, POLICY_FILE_NAME),
    identityFile: path.join(workspaceDir, IDENTITY_FILE_NAME),
    contextDietFile: path.join(workspaceDir, CONTEXT_DIET_FILE_NAME),
    modelRoutingFile: path.join(workspaceDir, MODEL_ROUTING_FILE_NAME),
    mcpFile: path.join(workspaceDir, MCP_FILE_NAME),
    githubFile: path.join(workspaceDir, GITHUB_FILE_NAME),
    mcpCacheDir: path.join(workspaceDir, ".cache", "mcp-tools"),
    missionsDir: path.join(workspaceDir, MISSIONS_DIR_NAME)
  };
}

export async function initWorkspace(cwd = process.cwd()): Promise<WorkspaceInitResult> {
  const paths = resolveWorkspacePaths(cwd);
  const result: WorkspaceInitResult = {
    paths,
    created: [],
    preserved: [],
    failed: []
  };

  await ensureDirectory(paths.workspaceDir, result);
  await ensureDirectory(paths.missionsDir, result);
  await ensureFile(paths.configFile, defaultConfigYaml(), result);
  await ensureFile(paths.policyFile, defaultPolicyYaml(), result);

  return result;
}

export async function doctorWorkspace(cwd = process.cwd()): Promise<DoctorResult> {
  const paths = resolveWorkspacePaths(cwd);
  const checks: DoctorCheck[] = [];

  checks.push(await checkDirectory("workspace directory", paths.workspaceDir));
  checks.push(await checkFile("config file", paths.configFile));
  checks.push(await checkFile("policy file", paths.policyFile));
  checks.push(await checkDirectory("missions directory", paths.missionsDir));

  const config = await loadWorkspaceConfig(paths.configFile);
  checks.push({
    name: "config yaml",
    ok: config.ok,
    message: config.ok ? "config.yaml parsed and passed validation" : `config.yaml invalid: ${config.message}`
  });

  const policy = await loadWorkspacePolicy(paths.policyFile);
  checks.push({
    name: "policy yaml",
    ok: policy.ok,
    message: policy.ok ? "policy.yaml parsed and passed validation" : `policy.yaml invalid: ${policy.message}`
  });

  const identityStat = await stat(paths.identityFile).catch(() => undefined);
  const identityLoad = await loadWorkspaceIdentityFile(paths.identityFile);
  const identityOk = identityLoad.ok || identityLoad.message === "ENOENT";
  checks.push({
    name: "identity yaml",
    ok: identityOk,
    message: !identityOk
      ? `identity.yaml invalid: ${identityLoad.message}`
      : identityStat?.isFile()
        ? identityLoad.ok
          ? `identity.yaml OK (actor_id=${identityLoad.value.actor_id})`
          : "identity.yaml missing"
        : process.env.NARTHYNX_ACTOR_ID?.trim()
          ? "no identity.yaml (using NARTHYNX_ACTOR_ID for ledger attribution)"
          : "no identity.yaml (optional; set identity.yaml or NARTHYNX_ACTOR_ID for approval/note attribution)"
  });

  const mcpConfig = await loadMcpConfig(paths.mcpFile);
  checks.push({
    name: "mcp yaml",
    ok: mcpConfig.ok,
    message: mcpConfig.ok
      ? mcpConfig.value.servers.length > 0
        ? `mcp.yaml OK (${mcpConfig.value.servers.length} server(s))`
        : "mcp.yaml absent or empty (no MCP servers configured)"
      : `mcp.yaml invalid: ${mcpConfig.message}`
  });

  const githubConfig = await loadGithubConfig(paths.githubFile);
  checks.push({
    name: "github yaml",
    ok: githubConfig.ok,
    message: githubConfig.ok
      ? githubConfig.value.repos_allow?.length
        ? `github.yaml OK (repos_allow: ${githubConfig.value.repos_allow.length})`
        : "github.yaml absent or has no repos_allow"
      : `github.yaml invalid: ${githubConfig.message}`
  });

  if (policy.ok && githubConfig.ok && policy.value.github !== "block") {
    const token = getGithubAuthToken();
    checks.push({
      name: "github token",
      ok: Boolean(token),
      message: token
        ? "GITHUB_TOKEN or GH_TOKEN is set"
        : "GITHUB_TOKEN or GH_TOKEN is not set (required for github.* tools when policy allows GitHub)"
    });
  }

  if (
    policy.ok &&
    githubConfig.ok &&
    policy.value.github_repos_allow &&
    githubConfig.value.repos_allow &&
    policy.value.github_repos_allow.length > 0 &&
    githubConfig.value.repos_allow.length > 0
  ) {
    const pSet = new Set(policy.value.github_repos_allow.map(normalizeRepoAllowEntry));
    const intersection = githubConfig.value.repos_allow.map(normalizeRepoAllowEntry).filter((r) => pSet.has(r));
    const coherenceOk = intersection.length > 0;
    checks.push({
      name: "github allowlist intersection",
      ok: coherenceOk,
      message: coherenceOk
        ? `policy and github.yaml allowlists overlap (${intersection.length} repo(s))`
        : "policy.github_repos_allow and github.yaml repos_allow have no common entries (empty intersection)"
    });
  }

  const dietConfig = await loadContextDietConfig(paths.contextDietFile);
  const dietFileStat = await stat(paths.contextDietFile).catch(() => undefined);
  checks.push({
    name: "context diet yaml",
    ok: dietConfig.ok,
    message: !dietConfig.ok
      ? `context-diet.yaml invalid: ${dietConfig.message}`
      : dietFileStat?.isFile()
        ? `context-diet.yaml OK (pack_max_bytes=${dietConfig.value.pack_max_bytes})`
        : `no context-diet.yaml (defaults: pack_max_bytes=${dietConfig.value.pack_max_bytes})`
  });

  const routingConfig = await loadModelRoutingConfig(paths.modelRoutingFile);
  const routingStat = await stat(paths.modelRoutingFile).catch(() => undefined);
  checks.push({
    name: "model routing yaml",
    ok: routingConfig.ok,
    message: !routingConfig.ok
      ? `model-routing.yaml invalid: ${routingConfig.message}`
      : routingStat?.isFile()
        ? routingConfig.value.tasks && Object.keys(routingConfig.value.tasks).length > 0
          ? `model-routing.yaml OK (${Object.keys(routingConfig.value.tasks).length} task route(s))`
          : "model-routing.yaml OK (no per-task routes; using env/default stub)"
        : "no model-routing.yaml (env-based model provider selection)"
  });

  if (policy.ok && mcpConfig.ok && policy.value.mcp !== "block" && policy.value.mcp_servers_allow !== undefined) {
    const allowed = new Set(policy.value.mcp_servers_allow);
    const unknown = policy.value.mcp_servers_allow.filter((id) => !findMcpServer(mcpConfig.value, id));
    const blockedServers = mcpConfig.value.servers.filter((s) => !allowed.has(s.id));
    const coherenceOk = unknown.length === 0 && blockedServers.length === 0;
    checks.push({
      name: "mcp policy coherence",
      ok: coherenceOk,
      message:
        unknown.length > 0
          ? `mcp_servers_allow references unknown server id(s): ${unknown.join(", ")}`
          : blockedServers.length > 0
            ? `policy allows only [${[...allowed].join(", ")}]; configured but not allowed: ${blockedServers.map((s) => s.id).join(", ")}`
            : "MCP allowlist matches configured servers"
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    paths,
    checks
  };
}

async function ensureDirectory(targetPath: string, result: WorkspaceInitResult): Promise<void> {
  try {
    const existing = await stat(targetPath).catch(() => undefined);

    if (existing?.isDirectory()) {
      result.preserved.push(targetPath);
      return;
    }

    if (existing) {
      result.failed.push(`${targetPath} exists but is not a directory`);
      return;
    }

    await mkdir(targetPath, { recursive: true });
    result.created.push(targetPath);
  } catch (error) {
    result.failed.push(formatFailure(targetPath, error));
  }
}

async function ensureFile(targetPath: string, contents: string, result: WorkspaceInitResult): Promise<void> {
  try {
    const existing = await stat(targetPath).catch(() => undefined);

    if (existing?.isFile()) {
      result.preserved.push(targetPath);
      return;
    }

    if (existing) {
      result.failed.push(`${targetPath} exists but is not a file`);
      return;
    }

    await writeFile(targetPath, contents, { encoding: "utf8", flag: "wx" });
    result.created.push(targetPath);
  } catch (error) {
    result.failed.push(formatFailure(targetPath, error));
  }
}

async function checkDirectory(name: string, targetPath: string): Promise<DoctorCheck> {
  const existing = await stat(targetPath).catch(() => undefined);

  return {
    name,
    ok: Boolean(existing?.isDirectory()),
    message: existing?.isDirectory() ? `${targetPath} exists` : `${targetPath} is missing or is not a directory`
  };
}

async function checkFile(name: string, targetPath: string): Promise<DoctorCheck> {
  const existing = await stat(targetPath).catch(() => undefined);

  return {
    name,
    ok: Boolean(existing?.isFile()),
    message: existing?.isFile() ? `${targetPath} exists` : `${targetPath} is missing or is not a file`
  };
}

function formatFailure(targetPath: string, error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown filesystem failure";
  return `${targetPath}: ${message}`;
}
