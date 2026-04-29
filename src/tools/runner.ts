import type { z } from "zod";

import { resolveWorkspacePaths } from "../config/workspace";
import { appendLedgerEvent, ledgerFilePath } from "../missions/ledger";
import { createMissionStore, missionDirectory } from "../missions/store";
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

      if (tool.requiresApproval) {
        const message = `${tool.name} requires approval. Approval gates are not implemented until Phase 6.`;
        await appendFailed(ledgerPath, request, message, true);
        return { ok: false, toolName: tool.name, message, blocked: true };
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

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}
