import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { loadWorkspacePolicy } from "../config/load";
import { findMcpServer, loadMcpConfig } from "../config/mcp-config";
import { resolveWorkspacePaths } from "../config/workspace";
import { createArtifactStore, reportArtifactPath, writeOutputArtifact } from "../missions/artifacts";
import { missionDirectory } from "../missions/store";
import { browserTools } from "./browser";
import { classifyCommandSafety, resolveWorkspaceCommandCwd } from "./command-safety";
import { resolveGuardedWorkspacePath } from "./path-guard";
import { cacheEntryFresh, readMcpToolsCache, writeMcpToolsCache } from "./mcp-cache";
import { isMcpServerPolicyAllowed, mcpArgumentsFingerprint } from "./mcp-guard";
import { mcpCallTool, mcpListTools, mcpResultByteLength, truncateMcpResultForInline } from "./mcp-session";
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

const commandOutputSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  artifactPath: z.string().optional(),
  truncated: z.boolean()
});

const shellRunInputSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).default("."),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(5_000)
});

const gitDiffInputSchema = z.object({
  pathspecs: z.array(z.string()).default([]),
  stat: z.boolean().default(false),
  maxBytes: z.number().int().min(1_000).max(100_000).default(12_000)
});

const gitLogInputSchema = z.object({
  maxCount: z.number().int().min(1).max(100).default(20),
  oneline: z.boolean().default(true),
  maxBytes: z.number().int().min(1_000).max(100_000).default(12_000)
});

const gitCommandOutputSchema = z.object({
  isRepository: z.boolean(),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  artifactPath: z.string().optional(),
  truncated: z.boolean()
});

const reportWriteInputSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1)
});

const reportWriteOutputSchema = z.object({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative()
});

const mcpServersListInputSchema = z.object({});
const mcpServersListOutputSchema = z.object({
  servers: z.array(
    z.object({
      id: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      policyAllowed: z.boolean(),
      toolsAllow: z.array(z.string()).optional(),
      toolsDeny: z.array(z.string()),
      timeoutMs: z.number().optional(),
      maxOutputBytes: z.number().optional(),
      cache: z
        .object({
          cachedAt: z.string(),
          toolCount: z.number(),
          fresh: z.boolean()
        })
        .optional()
    })
  )
});

const mcpToolsListInputSchema = z.object({
  serverId: z.string().min(1),
  refresh: z.boolean().default(false)
});

const mcpToolsListOutputSchema = z.object({
  serverId: z.string(),
  source: z.enum(["cache", "live"]),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.unknown().optional()
    })
  ),
  cachedAt: z.string().optional()
});

const mcpToolsCallInputSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.unknown()).default({})
});

const mcpToolsCallOutputSchema = z.object({
  serverId: z.string(),
  toolName: z.string(),
  argumentsFingerprint: z.string(),
  content: z.unknown(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
  artifactPath: z.string().optional(),
  truncated: z.boolean(),
  resultBytes: z.number().int()
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
    name: "git.diff",
    description: "Read local git diff without running a shell.",
    inputSchema: gitDiffInputSchema,
    outputSchema: gitCommandOutputSchema,
    riskLevel: "low",
    sideEffect: "local_read",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const parsed = gitDiffInputSchema.parse(input);
      const args = ["diff", parsed.stat ? "--stat" : undefined, "--", ...parsed.pathspecs].filter((arg): arg is string => Boolean(arg));
      const result = await runGitReadCommand({
        cwd: context.cwd,
        missionId: context.missionId,
        args,
        artifactType: "git_diff",
        artifactPrefix: "git-diff",
        maxBytes: parsed.maxBytes
      });

      return result;
    }
  },
  {
    name: "git.log",
    description: "Read local git log without running a shell.",
    inputSchema: gitLogInputSchema,
    outputSchema: gitCommandOutputSchema,
    riskLevel: "low",
    sideEffect: "local_read",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const parsed = gitLogInputSchema.parse(input);
      const args = ["log", `--max-count=${parsed.maxCount}`, parsed.oneline ? "--oneline" : undefined].filter((arg): arg is string =>
        Boolean(arg)
      );
      const result = await runGitReadCommand({
        cwd: context.cwd,
        missionId: context.missionId,
        args,
        artifactType: "git_log",
        artifactPrefix: "git-log",
        maxBytes: parsed.maxBytes
      });

      return result;
    }
  },
  {
    name: "shell.run",
    description: "Run a local command through the approval-gated shell connector.",
    inputSchema: shellRunInputSchema,
    outputSchema: commandOutputSchema,
    riskLevel: "high",
    sideEffect: "shell",
    requiresApproval: true,
    reversible: false,
    async run(input, context) {
      const parsed = shellRunInputSchema.parse(input);
      const safety = classifyCommandSafety({
        command: parsed.command,
        args: parsed.args
      });
      if (!safety.ok) {
        throw new Error(safety.reason ?? "shell.run input is blocked by safety policy.");
      }

      const commandCwd = resolveWorkspaceCommandCwd(context.cwd, parsed.cwd);
      const startedAt = Date.now();
      const result = await runProcess(parsed.command, parsed.args, {
        cwd: commandCwd.absolutePath,
        timeoutMs: parsed.timeoutMs
      });
      const durationMs = Date.now() - startedAt;
      const artifact = await writeCommandOutput({
        cwd: context.cwd,
        missionId: context.missionId,
        type: "command_output",
        filePrefix: "shell-run",
        title: `shell.run ${parsed.command}`,
        command: parsed.command,
        args: parsed.args,
        commandCwd: commandCwd.relativePath,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        durationMs
      });
      const stdout = truncate(result.stdout, 12_000);
      const stderr = truncate(result.stderr, 12_000);

      return {
        command: parsed.command,
        args: parsed.args,
        cwd: commandCwd.relativePath,
        exitCode: result.exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        timedOut: result.timedOut,
        durationMs,
        artifactPath: artifact.path,
        truncated: stdout.truncated || stderr.truncated
      };
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
    async run(input, context) {
      const parsed = reportWriteInputSchema.parse(input);
      const paths = resolveWorkspacePaths(context.cwd);
      const normalized = parsed.path.replaceAll("\\", "/");

      if (normalized !== "report.md" && normalized !== "artifacts/report.md") {
        throw new Error("report.write can only write the mission report artifact: report.md");
      }

      const filePath = reportArtifactPath(missionDirectory(paths.missionsDir, context.missionId));
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, parsed.content, "utf8");
      const { artifact } = await createArtifactStore(context.cwd).registerReportArtifact({
        missionId: context.missionId,
        title: "Mission report",
        metadata: {
          source: "report.write",
          bytes: Buffer.byteLength(parsed.content, "utf8")
        }
      });

      return {
        path: artifact.path,
        bytesWritten: Buffer.byteLength(parsed.content, "utf8")
      };
    }
  },
  ...browserTools,
  {
    name: "mcp.servers.list",
    description: "List MCP servers from .narthynx/mcp.yaml and optional cached tool discovery metadata.",
    inputSchema: mcpServersListInputSchema,
    outputSchema: mcpServersListOutputSchema,
    riskLevel: "low",
    sideEffect: "local_read",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      mcpServersListInputSchema.parse(input);
      const paths = resolveWorkspacePaths(context.cwd);
      const mcp = await loadMcpConfig(paths.mcpFile);
      if (!mcp.ok) {
        throw new Error(`mcp.yaml invalid: ${mcp.message}`);
      }
      const policy = await loadWorkspacePolicy(paths.policyFile);
      if (!policy.ok) {
        throw new Error(`policy.yaml invalid: ${policy.message}`);
      }

      const servers = [];
      for (const s of mcp.value.servers) {
        const cache = await readMcpToolsCache(paths.mcpCacheDir, s.id, Number.POSITIVE_INFINITY);
        const fresh = cacheEntryFresh(cache, 5 * 60 * 1_000);
        servers.push({
          id: s.id,
          command: s.command,
          args: s.args,
          policyAllowed: isMcpServerPolicyAllowed(policy.value, s.id),
          toolsAllow: s.tools_allow,
          toolsDeny: s.tools_deny,
          timeoutMs: s.timeoutMs,
          maxOutputBytes: s.maxOutputBytes,
          cache: cache ? { cachedAt: cache.cachedAt, toolCount: cache.tools.length, fresh } : undefined
        });
      }

      return { servers };
    }
  },
  {
    name: "mcp.tools.list",
    description: "List tools from an MCP server (cached up to ~5 minutes unless refresh is true).",
    inputSchema: mcpToolsListInputSchema,
    outputSchema: mcpToolsListOutputSchema,
    riskLevel: "medium",
    sideEffect: "local_read",
    requiresApproval: false,
    reversible: true,
    async run(input, context) {
      const parsed = mcpToolsListInputSchema.parse(input);
      const paths = resolveWorkspacePaths(context.cwd);
      const mcp = await loadMcpConfig(paths.mcpFile);
      if (!mcp.ok) {
        throw new Error(`mcp.yaml invalid: ${mcp.message}`);
      }
      const server = findMcpServer(mcp.value, parsed.serverId);
      if (!server) {
        throw new Error(`Unknown MCP server id: ${parsed.serverId}`);
      }

      const timeoutMs = server.timeoutMs ?? 10_000;

      if (!parsed.refresh) {
        const cached = await readMcpToolsCache(paths.mcpCacheDir, parsed.serverId);
        if (cached && cacheEntryFresh(cached, 5 * 60 * 1_000)) {
          return {
            serverId: parsed.serverId,
            source: "cache" as const,
            tools: cached.tools,
            cachedAt: cached.cachedAt
          };
        }
      }

      const tools = await mcpListTools(server, paths.rootDir, timeoutMs);
      const cachedAt = new Date().toISOString();
      await writeMcpToolsCache(paths.mcpCacheDir, {
        serverId: parsed.serverId,
        cachedAt,
        tools
      });

      return {
        serverId: parsed.serverId,
        source: "live" as const,
        tools,
        cachedAt
      };
    }
  },
  {
    name: "mcp.tools.call",
    description: "Call a tool on an MCP server (stdio). May write an artifact when output exceeds server maxOutputBytes.",
    inputSchema: mcpToolsCallInputSchema,
    outputSchema: mcpToolsCallOutputSchema,
    riskLevel: "high",
    sideEffect: "external_comm",
    requiresApproval: true,
    reversible: false,
    async run(input, context) {
      const parsed = mcpToolsCallInputSchema.parse(input);
      const paths = resolveWorkspacePaths(context.cwd);
      const mcp = await loadMcpConfig(paths.mcpFile);
      if (!mcp.ok) {
        throw new Error(`mcp.yaml invalid: ${mcp.message}`);
      }
      const server = findMcpServer(mcp.value, parsed.serverId);
      if (!server) {
        throw new Error(`Unknown MCP server id: ${parsed.serverId}`);
      }

      const timeoutMs = server.timeoutMs ?? 10_000;
      const maxOut = server.maxOutputBytes ?? 500_000;
      const fingerprint = mcpArgumentsFingerprint(parsed.arguments);

      const raw = await mcpCallTool(server, paths.rootDir, timeoutMs, parsed.name, parsed.arguments);
      const bytes = mcpResultByteLength(raw);
      let artifactPath: string | undefined;
      let truncated = false;
      let content: unknown = raw.content;
      let structuredContent: unknown = raw.structuredContent;

      if (bytes > maxOut) {
        const full = JSON.stringify(raw, null, 2);
        const now = new Date().toISOString().replace(/[:.]/g, "-");
        const safeName = `mcp-${parsed.serverId}-${parsed.name}-${now}.json`.replace(/[^a-zA-Z0-9_.-]/g, "_");
        const written = await writeOutputArtifact(context.cwd, context.missionId, safeName, full);
        await createArtifactStore(context.cwd).registerArtifact({
          missionId: context.missionId,
          type: "mcp_tool_output",
          title: `MCP ${parsed.serverId}/${parsed.name} output`,
          relativePath: written.relativePath,
          metadata: {
            serverId: parsed.serverId,
            toolName: parsed.name,
            bytes,
            argumentsFingerprint: fingerprint
          }
        });
        artifactPath = written.relativePath;
        const preview = truncateMcpResultForInline(raw, 8_000);
        content = typeof preview.inline === "string" ? preview.inline : preview.inline.content;
        structuredContent = undefined;
        truncated = true;
      } else {
        const preview = truncateMcpResultForInline(raw, 12_000);
        if (preview.truncated) {
          truncated = true;
          content = preview.inline;
          structuredContent = undefined;
        }
      }

      return {
        serverId: parsed.serverId,
        toolName: parsed.name,
        argumentsFingerprint: fingerprint,
        content,
        structuredContent,
        isError: raw.isError,
        artifactPath,
        truncated,
        resultBytes: bytes
      };
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

async function runGitReadCommand(input: {
  cwd: string;
  missionId: string;
  args: string[];
  artifactType: "git_diff" | "git_log";
  artifactPrefix: string;
  maxBytes: number;
}) {
  const result = await runProcess("git", input.args, {
    cwd: input.cwd,
    timeoutMs: 5_000
  });
  const isRepository = !(result.exitCode !== 0 && /not a git repository/i.test(result.stderr));

  if (!isRepository) {
    return {
      isRepository: false,
      exitCode: result.exitCode,
      stdout: "",
      stderr: result.stderr,
      truncated: false
    };
  }

  const artifact = await writeCommandOutput({
    cwd: input.cwd,
    missionId: input.missionId,
    type: input.artifactType,
    filePrefix: input.artifactPrefix,
    title: input.artifactType === "git_diff" ? "Git diff output" : "Git log output",
    command: "git",
    args: input.args,
    commandCwd: ".",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    durationMs: 0
  });
  const stdout = truncate(result.stdout, input.maxBytes);
  const stderr = truncate(result.stderr, input.maxBytes);

  return {
    isRepository: true,
    exitCode: result.exitCode,
    stdout: stdout.value,
    stderr: stderr.value,
    artifactPath: artifact.path,
    truncated: stdout.truncated || stderr.truncated
  };
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number }
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error.message,
        timedOut
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut
      });
    });
  });
}

async function writeCommandOutput(input: {
  cwd: string;
  missionId: string;
  type: "command_output" | "git_diff" | "git_log";
  filePrefix: string;
  title: string;
  command: string;
  args: string[];
  commandCwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}): Promise<{ path: string }> {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${input.filePrefix}-${now}.txt`;
  const content = [
    `command: ${input.command}`,
    `args: ${JSON.stringify(input.args)}`,
    `cwd: ${input.commandCwd}`,
    `exitCode: ${input.exitCode}`,
    `timedOut: ${input.timedOut}`,
    `durationMs: ${input.durationMs}`,
    "",
    "stdout:",
    input.stdout,
    "",
    "stderr:",
    input.stderr
  ].join("\n");
  const written = await writeOutputArtifact(input.cwd, input.missionId, fileName, content);
  const { artifact } = await createArtifactStore(input.cwd).registerArtifact({
    missionId: input.missionId,
    type: input.type,
    title: input.title,
    relativePath: written.relativePath,
    metadata: {
      command: input.command,
      args: input.args,
      cwd: input.commandCwd,
      exitCode: input.exitCode,
      timedOut: input.timedOut,
      durationMs: input.durationMs,
      bytes: Buffer.byteLength(content, "utf8")
    }
  });

  return {
    path: artifact.path
  };
}

function truncate(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return {
      value,
      truncated: false
    };
  }

  return {
    value: `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated to ${maxBytes} bytes]`,
    truncated: true
  };
}
