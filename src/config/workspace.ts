import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CONFIG_FILE_NAME,
  MISSIONS_DIR_NAME,
  POLICY_FILE_NAME,
  WORKSPACE_DIR_NAME,
  defaultConfigYaml,
  defaultPolicyYaml
} from "./defaults";
import { loadWorkspaceConfig, loadWorkspacePolicy } from "./load";

export interface WorkspacePaths {
  rootDir: string;
  workspaceDir: string;
  configFile: string;
  policyFile: string;
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
