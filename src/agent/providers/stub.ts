import { createDeterministicPlanGraph } from "../../missions/graph";
import type { Mission } from "../../missions/schema";
import type { ModelCallRequest, ModelCallResponse, ModelProvider } from "../model-provider";

export interface StubPlanningInput {
  mission: Pick<Mission, "id" | "title" | "goal" | "successCriteria">;
}

interface CompanionTurnInputEnvelope {
  userMessage?: string;
  personaName?: string;
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
  if (request.task === "companion_chat") {
    return renderCompanionStubContent(request.input);
  }

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

/** Deterministic heuristic companion replies for offline CI (`companion_mode: local_stub`). */
function renderCompanionStubContent(input: unknown): string {
  const env =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).companionEnvelope
      : undefined;
  let text = "";
  if (typeof env === "object" && env !== null) {
    const u = (env as CompanionTurnInputEnvelope).userMessage;
    text = typeof u === "string" ? u.trim().toLowerCase() : "";
  }

  const name =
    typeof env === "object" && env !== null && typeof (env as CompanionTurnInputEnvelope).personaName === "string"
      ? (env as CompanionTurnInputEnvelope).personaName
      : "Companion";

  let payload: Record<string, unknown> = {
    reply: `${name}: I'm running in local stub mode (no cloud model). Type goals naturally; I'll suggest missions when appropriate.`
  };

  const wantsMission =
    text.includes("create") && text.includes("mission") && !text.includes("remember");
  if (wantsMission || text.includes("fix bug")) {
    payload = {
      reply:
        "I captured a tentative goal. Confirm with /mission <goal> after reviewing, or use /mission-from-chat create to materialize.",
      suggestMission: {
        title: "Companion draft",
        goal: "Implement the next concrete Narthynx improvement the user requested."
      }
    };
  } else if (text.startsWith("remember:")) {
    payload = {
      reply: `Noted "${text}". This will be queued as memory pending approval (use companion memory slash commands once saved).`,
      proposeMemory: { text: text.replace(/^remember:\s*/i, "").trim() || text }
    };
  }

  return JSON.stringify(payload);
}
