import type { Mission } from "../missions/schema";
import { planGraphSchema, type PlanGraph } from "../missions/graph";

import type { ModelRouter } from "../agent/model-router";
import type { SubagentBudget } from "./budget";
import type { PlannerProposal } from "./schema";

function extractJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }
}

export async function runPlannerDraft(input: {
  missionId: string;
  mission: Mission;
  baseline: PlanGraph;
  router: ModelRouter;
  budget: SubagentBudget;
}): Promise<PlannerProposal> {
  const fallbackGraph = structuredClone(input.baseline);

  if (!input.budget.consumeModelCall()) {
    return {
      rationale: "Skipped model drafting (budget exhausted); returning deterministic baseline snapshot.",
      proposedGraph: fallbackGraph
    };
  }

  try {
    const response = await input.router.call({
      missionId: input.missionId,
      task: "subagent_planner",
      purpose: "bounded subagent planner draft graph",
      sensitiveContextIncluded: false,
      input: {
        mission: {
          id: input.mission.id,
          title: input.mission.title,
          goal: input.mission.goal,
          successCriteria: input.mission.successCriteria
        },
        baselineGraph: input.baseline,
        expectedGraphSchema: "PlanGraph v1"
      }
    });

    const raw = extractJson(response.content);
    const candidate = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).proposedGraph ?? raw : undefined;
    const parsedGraph = candidate ? planGraphSchema.safeParse(candidate) : undefined;

    const rationaleRaw =
      typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>).rationale === "string"
        ? (raw as Record<string, unknown>).rationale
        : "Model returned a proposed PlanGraph.";
    const rationale = rationaleRaw.trim().slice(0, 4_096);

    if (parsedGraph?.success) {
      return { rationale, proposedGraph: parsedGraph.data };
    }
  } catch {
    /* ignore */
  }

  return {
    rationale: "Model draft unavailable or unparsable; returning deterministic baseline graph.",
    proposedGraph: fallbackGraph
  };
}
