import type { z } from "zod";

import { loadMcpConfig } from "../config/mcp-config";
import { loadWorkspacePolicy, type WorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { createApprovalStore } from "../missions/approvals";
import { createCheckpointStore } from "../missions/checkpoints";
import { appendLedgerEvent, ledgerFilePath } from "../missions/ledger";
import { createMissionStore, missionDirectory } from "../missions/store";
import { extractBrowserUrlsFromInput, isBrowserToolName, classifyBrowserInputSafety } from "./browser-guard";
import { classifyShellRunInputSafety, shellRunApprovalTarget } from "./command-safety";
import { classifyMcpInputSafety } from "./mcp-guard";
import { classifyToolPolicy } from "./policy";
import { createToolRegistry, type ToolRegistry } from "./registry";
import type { ToolRunRequest, ToolRunResult } from "./types";

export interface ToolRunnerOptions {
  cwd?: string;
  registry?: ToolRegistry;
}

export function createToolRunner(options: ToolRunnerOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  const registry = options.registry ?? createToolRegistry();
  const missionStore = createMissionStore(cwd);
  const approvalStore = createApprovalStore(cwd);
  const checkpointStore = createCheckpointStore(cwd);
  const paths = resolveWorkspacePaths(cwd);

  return {
    async runTool(request: ToolRunRequest): Promise<ToolRunResult> {
      await missionStore.readMission(request.missionId);
      const ledgerPath = ledgerFilePath(missionDirectory(paths.missionsDir, request.missionId));

      await appendLedgerEvent(ledgerPath, {
        missionId: request.missionId,
        type: "tool.requested",
        summary: `Tool requested: ${request.toolName}`,
        details: {
          toolName: request.toolName
        }
      });

      let tool;
      try {
        tool = registry.get(request.toolName);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown tool";
        await appendFailed(ledgerPath, request, message);
        return { ok: false, toolName: request.toolName, message, blocked: false };
      }

      const input = tool.inputSchema.safeParse(request.input);
      if (!input.success) {
        const message = `Invalid input for ${tool.name}: ${formatZodError(input.error)}`;
        await appendFailed(ledgerPath, request, message);
        return { ok: false, toolName: tool.name, message, blocked: false };
      }

      const policy = await loadWorkspacePolicy(paths.policyFile);
      if (!policy.ok) {
        const message = `policy.yaml invalid: ${policy.message}`;
        await appendFailed(ledgerPath, request, message);
        return { ok: false, toolName: tool.name, message, blocked: false };
      }

      const inputSafety = await classifyToolInputSafety(tool.name, input.data, paths.rootDir, policy.value);
      if (!inputSafety.ok) {
        const message = inputSafety.reason ?? `${tool.name} input is blocked by safety policy.`;
        await appendDenied(ledgerPath, request, message, "blocked");
        return { ok: false, toolName: tool.name, message, blocked: true };
      }

      const decision = classifyToolPolicy(tool, policy.value, input.data);
      if (decision.action === "block") {
        await appendDenied(ledgerPath, request, decision.reason, "blocked");
        return { ok: false, toolName: tool.name, message: decision.reason, blocked: true };
      }

      if (decision.action === "approval") {
        const approval = await approvalStore.createApproval({
          missionId: request.missionId,
          toolName: tool.name,
          toolInput: input.data,
          riskLevel: decision.riskLevel,
          sideEffect: tool.sideEffect,
          reason: decision.reason,
          target: approvalTargetForTool(tool.name, input.data)
        });
        const message = `${tool.name} requires approval. Run: narthynx approve ${approval.id}`;
        await appendDenied(ledgerPath, request, message, "pending_approval", approval.id);
        return { ok: false, toolName: tool.name, message, blocked: true, approvalId: approval.id };
      }

      return executeTool({
        cwd,
        ledgerPath,
        missionId: request.missionId,
        tool,
        input: input.data,
        request
      });
    },

    async runApprovedTool(approvalId: string): Promise<ToolRunResult> {
      const approval = await approvalStore.getApproval(approvalId);
      await missionStore.readMission(approval.missionId);
      const ledgerPath = ledgerFilePath(missionDirectory(paths.missionsDir, approval.missionId));

      if (approval.status !== "approved") {
        return {
          ok: false,
          toolName: approval.toolName,
          message: `Approval ${approvalId} is ${approval.status}, not approved.`,
          blocked: true
        };
      }

      if (approval.executedAt) {
        return {
          ok: false,
          toolName: approval.toolName,
          message: `Approval ${approvalId} has already been executed.`,
          blocked: true,
          approvalId
        };
      }

      if (!isApprovalContinuationTool(approval.toolName)) {
        return {
          ok: false,
          toolName: approval.toolName,
          message: `${approval.toolName} continuation is not implemented for this tool.`,
          blocked: true,
          approvalId
        };
      }

      const tool = registry.get(approval.toolName);
      const input = tool.inputSchema.safeParse(approval.toolInput);
      if (!input.success) {
        const message = `Invalid approved input for ${tool.name}: ${formatZodError(input.error)}`;
        await appendFailed(ledgerPath, { missionId: approval.missionId, toolName: tool.name, input: approval.toolInput }, message);
        return { ok: false, toolName: tool.name, message, blocked: false, approvalId };
      }

      const policyReload = await loadWorkspacePolicy(paths.policyFile);
      if (!policyReload.ok) {
        const message = `policy.yaml invalid: ${policyReload.message}`;
        await appendFailed(ledgerPath, { missionId: approval.missionId, toolName: tool.name, input: approval.toolInput }, message);
        return { ok: false, toolName: tool.name, message, blocked: false, approvalId };
      }

      const inputSafety = await classifyToolInputSafety(tool.name, input.data, paths.rootDir, policyReload.value);
      if (!inputSafety.ok) {
        const message = inputSafety.reason ?? `${tool.name} input is blocked by safety policy.`;
        await appendFailed(ledgerPath, { missionId: approval.missionId, toolName: tool.name, input: approval.toolInput }, message, true);
        return { ok: false, toolName: tool.name, message, blocked: true, approvalId };
      }

      let checkpointId: string | undefined;
      if (approval.toolName === "filesystem.write") {
        try {
          const checkpoint = await checkpointStore.createFilesystemWriteCheckpoint(approval);
          checkpointId = checkpoint.id;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown checkpoint failure";
          await appendFailed(ledgerPath, { missionId: approval.missionId, toolName: tool.name, input: approval.toolInput }, message);
          return { ok: false, toolName: tool.name, message, blocked: false, approvalId };
        }
      }

      const result = await executeTool({
        cwd,
        ledgerPath,
        missionId: approval.missionId,
        tool,
        input: input.data,
        request: {
          missionId: approval.missionId,
          toolName: tool.name,
          input: approval.toolInput
        },
        checkpointId
      });

      if (result.ok) {
        await approvalStore.markApprovalExecuted(approvalId, checkpointId);
      }

      return result;
    }
  };
}

async function executeTool(input: {
  cwd: string;
  ledgerPath: string;
  missionId: string;
  tool: ReturnType<ToolRegistry["get"]>;
  input: unknown;
  request: ToolRunRequest;
  checkpointId?: string;
}): Promise<ToolRunResult> {
  await appendLedgerEvent(input.ledgerPath, {
    missionId: input.missionId,
    type: "tool.started",
    summary: `Tool started: ${input.tool.name}`,
    details: {
      toolName: input.tool.name,
      sideEffect: input.tool.sideEffect,
      riskLevel: input.tool.riskLevel,
      checkpointId: input.checkpointId
    }
  });

  try {
    const rawOutput = await input.tool.run(input.input, {
      cwd: input.cwd,
      missionId: input.missionId
    });
    const output = input.tool.outputSchema.safeParse(rawOutput);

    if (!output.success) {
      const message = `Invalid output for ${input.tool.name}: ${formatZodError(output.error)}`;
      await appendFailed(input.ledgerPath, input.request, message);
      return { ok: false, toolName: input.tool.name, message, blocked: false };
    }

    await appendLedgerEvent(input.ledgerPath, {
      missionId: input.missionId,
      type: "tool.completed",
      summary: `Tool completed: ${input.tool.name}`,
      details: {
        toolName: input.tool.name,
        checkpointId: input.checkpointId
      }
    });

    return {
      ok: true,
      toolName: input.tool.name,
      output: output.data,
      checkpointId: input.checkpointId
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown tool runtime failure";
    await appendFailed(input.ledgerPath, input.request, message);
    return { ok: false, toolName: input.tool.name, message, blocked: false };
  }
}

async function appendFailed(
  ledgerPath: string,
  request: ToolRunRequest,
  message: string,
  blocked = false
): Promise<void> {
  await appendLedgerEvent(ledgerPath, {
    missionId: request.missionId,
    type: "tool.failed",
    summary: blocked ? `Tool blocked: ${request.toolName}` : `Tool failed: ${request.toolName}`,
    details: {
      toolName: request.toolName,
      message,
      blocked
    }
  });
}

async function appendDenied(
  ledgerPath: string,
  request: ToolRunRequest,
  message: string,
  status: "blocked" | "pending_approval",
  approvalId?: string
): Promise<void> {
  await appendLedgerEvent(ledgerPath, {
    missionId: request.missionId,
    type: "tool.denied",
    summary: status === "pending_approval" ? `Tool pending approval: ${request.toolName}` : `Tool denied: ${request.toolName}`,
    details: {
      toolName: request.toolName,
      message,
      status,
      approvalId
    }
  });
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

async function classifyToolInputSafety(
  toolName: string,
  input: unknown,
  rootDir: string,
  policy: WorkspacePolicy
): Promise<{ ok: boolean; reason?: string }> {
  if (toolName === "shell.run") {
    return classifyShellRunInputSafety(input, rootDir);
  }

  if (isBrowserToolName(toolName)) {
    const r = classifyBrowserInputSafety(toolName, input, policy);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  if (toolName.startsWith("mcp.")) {
    const wsPaths = resolveWorkspacePaths(rootDir);
    const mcpConfig = await loadMcpConfig(wsPaths.mcpFile);
    if (!mcpConfig.ok) {
      return { ok: false, reason: `mcp.yaml invalid: ${mcpConfig.message}` };
    }
    return classifyMcpInputSafety(toolName, input, {
      rootDir: wsPaths.rootDir,
      policy,
      mcpConfig: mcpConfig.value
    });
  }

  return { ok: true };
}

function approvalTargetForTool(toolName: string, input: unknown): string | undefined {
  if (toolName === "shell.run") {
    return shellRunApprovalTarget(input);
  }

  if (isBrowserToolName(toolName)) {
    const urls = extractBrowserUrlsFromInput(toolName, input);
    return urls[0];
  }

  if (toolName === "mcp.tools.call" && typeof input === "object" && input !== null && "serverId" in input && "name" in input) {
    const sid = (input as { serverId?: unknown }).serverId;
    const name = (input as { name?: unknown }).name;
    if (typeof sid === "string" && typeof name === "string") {
      return `mcp:${sid}:${name}`;
    }
  }

  if (toolName === "mcp.tools.list" && typeof input === "object" && input !== null && "serverId" in input) {
    const sid = (input as { serverId?: unknown }).serverId;
    if (typeof sid === "string") {
      return `mcp:${sid}:tools.list`;
    }
  }

  if (typeof input === "object" && input !== null && "path" in input) {
    const value = (input as { path?: unknown }).path;
    return typeof value === "string" ? value : undefined;
  }

  return undefined;
}

function isApprovalContinuationTool(toolName: string): boolean {
  return (
    toolName === "filesystem.write" ||
    toolName === "report.write" ||
    toolName === "shell.run" ||
    toolName === "mcp.tools.list" ||
    toolName === "mcp.tools.call" ||
    isBrowserToolName(toolName)
  );
}
