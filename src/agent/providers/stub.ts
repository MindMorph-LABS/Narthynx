import { createDeterministicPlanGraph } from "../../missions/graph";
import type { Mission } from "../../missions/schema";
import type { ModelCallRequest, ModelCallResponse, ModelProvider } from "../model-provider";

export interface StubPlanningInput {
  mission: Pick<Mission, "id" | "title" | "goal" | "successCriteria">;
}

export function createStubModelProvider(): ModelProvider {
  return {
    name: "stub",
    model: "deterministic-local-stub",
    isNetworked: false,
    async call(request: ModelCallRequest): Promise<ModelCallResponse> {
      const started = Date.now();

      return {
        provider: "stub",
        model: "deterministic-local-stub",
        content: renderStubContent(request),
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0
        },
        cost: {
          estimatedCost: 0,
          currency: "USD"
        },
        latencyMs: Date.now() - started
      };
    }
  };
}

function renderStubContent(request: ModelCallRequest): string {
  if (request.task === "planning") {
    const input = request.input as Partial<StubPlanningInput>;
    if (input.mission?.id && input.mission.title && input.mission.goal && input.mission.successCriteria) {
      const mission = {
        id: input.mission.id,
        title: input.mission.title,
        goal: input.mission.goal,
        successCriteria: input.mission.successCriteria,
        context: { notes: [], files: [] },
        planGraph: { nodes: [], edges: [] },
        state: "created",
        riskProfile: { level: "low", reasons: ["Initial mission has no actions yet."] },
        checkpoints: [],
        approvals: [],
        artifacts: [],
        ledger: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
      } satisfies Mission;

      const graph = createDeterministicPlanGraph(mission);
      return JSON.stringify(graph);
    }
  }

  return JSON.stringify({
    provider: "stub",
    task: request.task,
    message: "Deterministic stub response. No model provider or network call was used."
  });
}
