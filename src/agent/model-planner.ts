import type { ZodError } from "zod";

import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { buildModelContextPack } from "../missions/context-diet";
import { createDeterministicPlanGraph, planGraphSchema, type PlanGraph } from "../missions/graph";
import { appendLedgerEvent, ledgerFilePath } from "../missions/ledger";
import { createMissionStore, missionDirectory } from "../missions/store";
import { createModelRouter, type ModelRouterOptions } from "./model-router";

export interface ModelPlanResult {
  graph: PlanGraph;
  provider: string;
  model: string;
}

export function createModelPlanner(cwd = process.cwd(), routerOptions: Omit<ModelRouterOptions, "cwd"> = {}) {
  const missionStore = createMissionStore(cwd);
  const router = createModelRouter({ cwd, ...routerOptions });

  return {
    async generatePlan(missionId: string): Promise<ModelPlanResult> {
      const mission = await missionStore.readMission(missionId);
      const fallbackGraph = createDeterministicPlanGraph(mission);
      const paths = resolveWorkspacePaths(cwd);
      const policy = await loadWorkspacePolicy(paths.policyFile);

      let packBlock:
        | {
            text: string;
            totals: { bytes: number; estimatedTokens: number; includedCount: number };
            sensitiveContextIncluded: boolean;
            contextPacketId?: string;
            exclusionCounts?: Record<string, number>;
          }
        | undefined;
      let sensitiveContextIncluded = false;

      if (policy.ok && (policy.value.cloud_model_sensitive_context === "allow" || policy.value.cloud_model_sensitive_context === "ask")) {
        const pack = await buildModelContextPack(missionId, cwd, { trigger: { source: "planning" } });
        packBlock = {
          text: pack.packText,
          totals: {
            bytes: pack.totals.bytes,
            estimatedTokens: pack.totals.estimatedTokens,
            includedCount: pack.totals.includedCount
          },
          sensitiveContextIncluded: pack.sensitiveContextIncluded,
          contextPacketId: pack.contextPacketId,
          exclusionCounts: pack.exclusionCounts
        };
        sensitiveContextIncluded = pack.sensitiveContextIncluded;
      }

      try {
        const response = await router.call({
          missionId,
          task: "planning",
          purpose: "mission planning",
          sensitiveContextIncluded,
          input: {
            mission: {
              id: mission.id,
              title: mission.title,
              goal: mission.goal,
              successCriteria: mission.successCriteria
            },
            expectedGraphSchema: "PlanGraph v1",
            baselineGraph: fallbackGraph,
            ...(packBlock
              ? {
                  modelContextPack: packBlock
                }
              : {})
          }
        });
        const graph = parseModelPlan(response.content);
        const updated = await missionStore.updateMissionPlanGraph(missionId, graph, {
          summary: `Model plan graph updated by ${response.provider}/${response.model}.`,
          provider: response.provider,
          model: response.model
        });

        return {
          graph: updated,
          provider: response.provider,
          model: response.model
        };
      } catch (error) {
        await appendPlanningError(cwd, missionId, error);
        throw error;
      }
    }
  };
}

function parseModelPlan(content: string): PlanGraph {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    throw new Error(`Model planning failed: provider returned invalid JSON: ${message}`);
  }

  const parsed = planGraphSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Model planning failed: provider returned an invalid plan graph: ${formatZodError(parsed.error)}`);
  }

  return parsed.data;
}

async function appendPlanningError(cwd: string, missionId: string, error: unknown): Promise<void> {
  const paths = resolveWorkspacePaths(cwd);
  const message = error instanceof Error ? error.message : "Unknown model planning failure";
  await appendLedgerEvent(ledgerFilePath(missionDirectory(paths.missionsDir, missionId)), {
    missionId,
    type: "error",
    summary: `Model planning failed: ${message}`,
    details: {
      message,
      phase: 12,
      operation: "model planning",
      stateSaved: true
    }
  });
}

function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}
