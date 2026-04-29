import type { z } from "zod";

import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { createApprovalStore } from "../missions/approvals";
import { appendLedgerEvent, ledgerFilePath } from "../missions/ledger";
import { createMissionStore, missionDirectory } from "../missions/store";
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

      const decision = classifyToolPolicy(tool, policy.value);
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
          reason: decision.reason
        });
        const message = `${tool.name} requires approval. Run: narthynx approve ${approval.id}`;
        await appendDenied(ledgerPath, request, message, "pending_approval", approval.id);
        return { ok: false, toolName: tool.name, message, blocked: true, approvalId: approval.id };
      }

      await appendLedgerEvent(ledgerPath, {
        missionId: request.missionId,
        type: "tool.started",
        summary: `Tool started: ${tool.name}`,
        details: {
          toolName: tool.name,
          sideEffect: tool.sideEffect,
          riskLevel: tool.riskLevel
        }
      });

      try {
        const rawOutput = await tool.run(input.data, {
          cwd,
          missionId: request.missionId
        });
        const output = tool.outputSchema.safeParse(rawOutput);

        if (!output.success) {
          const message = `Invalid output for ${tool.name}: ${formatZodError(output.error)}`;
          await appendFailed(ledgerPath, request, message);
          return { ok: false, toolName: tool.name, message, blocked: false };
        }

        await appendLedgerEvent(ledgerPath, {
          missionId: request.missionId,
          type: "tool.completed",
          summary: `Tool completed: ${tool.name}`,
          details: {
            toolName: tool.name
          }
        });

        return {
          ok: true,
          toolName: tool.name,
          output: output.data
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown tool runtime failure";
        await appendFailed(ledgerPath, request, message);
        return { ok: false, toolName: tool.name, message, blocked: false };
      }
    }
  };
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
