import { createDeterministicPlanGraph, planGraphSchema, type PlanGraph } from "../../missions/graph";
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

  if (request.task === "subagent_planner") {
    return renderSubagentPlannerStub(request.input);
  }

  if (request.task === "subagent_safety") {
    return JSON.stringify({
      blocked: false,
      severity: "medium",
      reasons: ["Stub safety review agrees with heuristic snapshot only."],
      heuristicNote: "stub_subagent_safety"
    });
  }

  if (request.task === "subagent_verifier") {
    return JSON.stringify({
      stub: true,
      message: "Verifier subagent uses deterministic gates; LM summary is optional and unused in MVP."
    });
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

function renderSubagentPlannerStub(input: unknown): string {
  const env = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const baseline = env.baselineGraph;
  const parsedBaseline = baseline ? planGraphSchema.safeParse(baseline) : undefined;
  let proposedGraph: PlanGraph | undefined = parsedBaseline?.success ? parsedBaseline.data : undefined;

  let rationale =
    parsedBaseline?.success === true
      ? "Stub planner: echoes validated baseline PlanGraph (no edits)."
      : "Stub planner baseline missing or invalid; derived graph from mission envelope.";

  if (!proposedGraph) {
    const m = env.mission as Partial<Mission> | undefined;
    if (m?.id && m.title && m.goal && m.successCriteria) {
      const missionSkeleton = {
        id: m.id,
        title: m.title,
        goal: m.goal,
        successCriteria: m.successCriteria,
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

      proposedGraph = createDeterministicPlanGraph(missionSkeleton);
      rationale =
        parsedBaseline?.success === false
          ? "Stub planner baseline failed schema; returned deterministic MVP graph seed."
          : rationale;
    }
  }

  if (!proposedGraph) {
    return JSON.stringify({
      rationale: "Stub planner missing mission envelope; downstream should use local baseline fallback.",
      proposedGraph: undefined
    });
  }

  return JSON.stringify({
    rationale,
    proposedGraph
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
