import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { resolveGuardedWorkspacePath } from "./path-guard";
import type { ToolAction } from "./types";

const execFileAsync = promisify(execFile);

const pathInputSchema = z.object({
  path: z.string().min(1).default(".")
});

const filesystemListOutputSchema = z.object({
  path: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["file", "directory", "other"])
    })
  )
});

const filesystemReadOutputSchema = z.object({
  path: z.string(),
  content: z.string()
});

const filesystemWriteInputSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

const filesystemWriteOutputSchema = z.object({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative()
});

const gitStatusInputSchema = z.object({});

const gitStatusOutputSchema = z.object({
  isRepository: z.boolean(),
  stdout: z.string(),
  stderr: z.string()
});

const reportWriteInputSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1)
});

const reportWriteOutputSchema = z.object({
  path: z.string()
});

export const builtinTools: ToolAction<unknown, unknown>[] = [
  {
    name: "filesystem.list",
    description: "List files and folders inside the local workspace.",
    inputSchema: pathInputSchema,
    outputSchema: filesystemListOutputSchema,
    riskLevel: "low",
    sideEffect: "local_read",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const parsed = pathInputSchema.parse(input);
      const policy = await loadPolicyOrThrow(context.cwd);
      const guarded = resolveGuardedWorkspacePath(context.cwd, parsed.path, policy);
      const target = await stat(guarded.absolutePath);

      if (!target.isDirectory()) {
        throw new Error(`Path is not a directory: ${parsed.path}`);
      }

      const entries = await readdir(guarded.absolutePath, { withFileTypes: true });
      return {
        path: guarded.relativePath,
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
        }))
      };
    }
  },
  {
    name: "filesystem.read",
    description: "Read a safe local workspace file.",
    inputSchema: pathInputSchema,
    outputSchema: filesystemReadOutputSchema,
    riskLevel: "low",
    sideEffect: "local_read",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const parsed = pathInputSchema.parse(input);
      const policy = await loadPolicyOrThrow(context.cwd);
      const guarded = resolveGuardedWorkspacePath(context.cwd, parsed.path, policy);
      const target = await stat(guarded.absolutePath);

      if (!target.isFile()) {
        throw new Error(`Path is not a file: ${parsed.path}`);
      }

      return {
        path: guarded.relativePath,
        content: await readFile(guarded.absolutePath, "utf8")
      };
    }
  },
  {
    name: "filesystem.write",
    description: "Write a local workspace file after explicit approval and checkpoint creation.",
    inputSchema: filesystemWriteInputSchema,
    outputSchema: filesystemWriteOutputSchema,
    riskLevel: "high",
    sideEffect: "local_write",
    requiresApproval: true,
    reversible: false,
    async run(input, context) {
      const parsed = filesystemWriteInputSchema.parse(input);
      const policy = await loadPolicyOrThrow(context.cwd);
      const guarded = resolveGuardedWorkspacePath(context.cwd, parsed.path, policy);
      const existing = await stat(guarded.absolutePath).catch(() => undefined);

      if (existing?.isDirectory()) {
        throw new Error(`Path is a directory and cannot be written as a file: ${parsed.path}`);
      }

      await mkdir(path.dirname(guarded.absolutePath), { recursive: true });
      await writeFile(guarded.absolutePath, parsed.content, "utf8");

      return {
        path: guarded.relativePath,
        bytesWritten: Buffer.byteLength(parsed.content, "utf8")
      };
    }
  },
  {
    name: "git.status",
    description: "Read local git status without running a shell.",
    inputSchema: gitStatusInputSchema,
    outputSchema: gitStatusOutputSchema,
    riskLevel: "low",
    sideEffect: "local_read",
    requiresApproval: false,
    reversible: true,
    async run(_input, context) {
      try {
        const result = await execFileAsync("git", ["status", "--short", "--branch"], {
          cwd: context.cwd,
          timeout: 2_000,
          windowsHide: true
        });

        return {
          isRepository: true,
          stdout: result.stdout,
          stderr: result.stderr
        };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        return {
          isRepository: false,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? (error instanceof Error ? error.message : "git status failed")
        };
      }
    }
  },
  {
    name: "report.write",
    description: "Write a local mission report after report generation exists.",
    inputSchema: reportWriteInputSchema,
    outputSchema: reportWriteOutputSchema,
    riskLevel: "medium",
    sideEffect: "local_write",
    requiresApproval: true,
    reversible: false,
    async run() {
      throw new Error("report.write is blocked until report generation is implemented in Phase 8.");
    }
  }
];

async function loadPolicyOrThrow(cwd: string) {
  const paths = resolveWorkspacePaths(cwd);
  const policy = await loadWorkspacePolicy(paths.policyFile);
  if (!policy.ok) {
    throw new Error(`policy.yaml invalid: ${policy.message}`);
  }

  return policy.value;
}
