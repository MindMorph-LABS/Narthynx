import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildMissionCostSummary, createCostService } from "../src/agent/cost";
import { createModelPlanner } from "../src/agent/model-planner";
import { createModelRouter } from "../src/agent/model-router";
import { ModelProviderError } from "../src/agent/model-provider";
import { createOpenAICompatibleProvider } from "../src/agent/providers/openai-compatible";
import { createStubModelProvider } from "../src/agent/providers/stub";
import { defaultPolicyYaml } from "../src/config/defaults";
import { initWorkspace } from "../src/config/workspace";
import { createDeterministicPlanGraph } from "../src/missions/graph";
import { createApprovalStore } from "../src/missions/approvals";
import { createMissionStore } from "../src/missions/store";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-model-"));
}

async function initializedMission() {
  const cwd = await tempWorkspaceRoot();
  await initWorkspace(cwd);
  const store = createMissionStore(cwd);
  const mission = await store.createMission({ goal: "Prepare launch checklist" });

  return { cwd, store, mission };
}

describe("model providers", () => {
  it("returns deterministic planning JSON from the stub provider without cost", async () => {
    const { mission } = await initializedMission();
    const provider = createStubModelProvider();
    const response = await provider.call({
      missionId: mission.id,
      task: "planning",
      purpose: "mission planning",
      sensitiveContextIncluded: false,
      input: {
        mission: {
          id: mission.id,
          title: mission.title,
          goal: mission.goal,
          successCriteria: mission.successCriteria
        }
      }
    });

    expect(response.provider).toBe("stub");
    expect(response.cost?.estimatedCost).toBe(0);
    expect(JSON.parse(response.content)).toMatchObject({
      missionId: mission.id,
      version: 1
    });
  });

  it("builds OpenAI-compatible chat requests, parses usage, and redacts provider errors", async () => {
    const successfulFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"ok\":true}" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }),
        { status: 200 }
      );
    });
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://models.example/v1/",
      apiKey: "sk-test-secret",
      model: "planning-model",
      fetchImpl: successfulFetch as typeof fetch
    });
    const response = await provider.call({
      missionId: "m_abc123",
      task: "planning",
      purpose: "mission planning",
      sensitiveContextIncluded: false,
      input: { goal: "test" }
    });
    const [, init] = successfulFetch.mock.calls[0];

    expect(successfulFetch.mock.calls[0][0]).toBe("https://models.example/v1/chat/completions");
    expect(JSON.stringify(init)).toContain("planning-model");
    expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });

    const failingFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: "bad key sk-test-secret" } }), { status: 401 });
    });
    const failingProvider = createOpenAICompatibleProvider({
      baseUrl: "https://models.example/v1",
      apiKey: "sk-test-secret",
      model: "planning-model",
      fetchImpl: failingFetch as typeof fetch
    });

    await expect(
      failingProvider.call({
        missionId: "m_abc123",
        task: "planning",
        purpose: "mission planning",
        sensitiveContextIncluded: false,
        input: {}
      })
    ).rejects.toThrow("bad key [redacted]");
  });
});

describe("model router and planner", () => {
  it("selects the stub provider by default and records model and cost ledger events", async () => {
    const { cwd, store, mission } = await initializedMission();
    const router = createModelRouter({ cwd, env: {} });

    await router.call({
      missionId: mission.id,
      task: "planning",
      purpose: "mission planning",
      sensitiveContextIncluded: false,
      input: {
        mission: {
          id: mission.id,
          title: mission.title,
          goal: mission.goal,
          successCriteria: mission.successCriteria
        }
      }
    });
    const ledger = await store.readMissionLedger(mission.id);

    expect(ledger.map((event) => event.type).slice(-2)).toEqual(["model.called", "cost.recorded"]);
    expect(ledger.at(-2)?.details).toMatchObject({
      provider: "stub",
      model: "deterministic-local-stub",
      sensitiveContextIncluded: false
    });
  });

  it("blocks networked providers when policy allow_network is false", async () => {
    const { cwd, mission } = await initializedMission();
    const provider = fakeProvider({ isNetworked: true });
    const router = createModelRouter({ cwd, provider });

    await expect(
      router.call({
        missionId: mission.id,
        task: "planning",
        purpose: "mission planning",
        sensitiveContextIncluded: false,
        input: {}
      })
    ).rejects.toThrow("allow_network is false");
  });

  it("creates an approval for sensitive cloud model requests when policy is ask", async () => {
    const { cwd, mission } = await initializedMission();
    await writeFile(path.join(cwd, ".narthynx", "policy.yaml"), defaultPolicyYaml().replace("allow_network: false", "allow_network: true"), "utf8");
    const approvalStore = createApprovalStore(cwd);
    const provider = fakeProvider({ isNetworked: true });
    const router = createModelRouter({ cwd, provider, approvalStore });

    try {
      await router.call({
        missionId: mission.id,
        task: "planning",
        purpose: "mission planning",
        sensitiveContextIncluded: true,
        input: {}
      });
      expect.fail("expected sensitive_requires_approval");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderError);
      const err = error as ModelProviderError;
      expect(err.code).toBe("sensitive_requires_approval");
      expect(err.meta?.approvalId).toMatch(/^a_/);
    }

    const pending = await approvalStore.listPendingApprovals();
    expect(pending.length).toBe(1);
    expect(pending[0]?.toolName).toBe("narthynx.model.sensitive_context");
  });

  it("writes a validated model plan and leaves the graph unchanged on invalid model output", async () => {
    const { cwd, store, mission } = await initializedMission();
    const originalGraph = await store.readMissionPlanGraph(mission.id);
    const validGraph = createDeterministicPlanGraph(mission);
    const validProvider = fakeProvider({
      content: JSON.stringify({
        ...validGraph,
        nodes: [
          {
            ...validGraph.nodes[0],
            title: "Model understand goal"
          },
          ...validGraph.nodes.slice(1)
        ]
      })
    });
    const validResult = await createModelPlanner(cwd, { provider: validProvider }).generatePlan(mission.id);
    const invalidProvider = fakeProvider({ content: "{\"not\":\"a graph\"}" });

    await expect(createModelPlanner(cwd, { provider: invalidProvider }).generatePlan(mission.id)).rejects.toThrow(
      "invalid plan graph"
    );
    const afterInvalid = await store.readMissionPlanGraph(mission.id);
    const ledger = await store.readMissionLedger(mission.id);

    expect(validResult.graph.nodes[0]?.title).toBe("Model understand goal");
    expect(afterInvalid.nodes[0]?.title).toBe("Model understand goal");
    expect(afterInvalid).not.toEqual(originalGraph);
    expect(ledger.map((event) => event.type)).toContain("plan.updated");
    expect(ledger.at(-1)?.type).toBe("error");
  });
});

describe("cost summaries", () => {
  it("summarizes no-cost missions and aggregates model cost events", async () => {
    const { cwd, store, mission } = await initializedMission();
    const empty = await createCostService(cwd).summarizeMissionCost(mission.id);
    await createModelRouter({ cwd, env: {} }).call({
      missionId: mission.id,
      task: "planning",
      purpose: "mission planning",
      sensitiveContextIncluded: false,
      input: {
        mission: {
          id: mission.id,
          title: mission.title,
          goal: mission.goal,
          successCriteria: mission.successCriteria
        }
      }
    });
    const ledger = await store.readMissionLedger(mission.id);
    const summary = buildMissionCostSummary(mission.id, ledger);

    expect(empty.modelCallCount).toBe(0);
    expect(summary.modelCallCount).toBe(1);
    expect(summary.estimatedCost).toBe(0);
    expect(summary.providers[0]).toMatchObject({
      provider: "stub",
      model: "deterministic-local-stub",
      calls: 1
    });
  });
});

function fakeProvider(options: { isNetworked?: boolean; content?: string } = {}): ModelProvider {
  return {
    name: "fake",
    model: "fake-model",
    isNetworked: options.isNetworked ?? false,
    async call(request: ModelCallRequest) {
      return {
        provider: "fake",
        model: "fake-model",
        content: options.content ?? JSON.stringify({ task: request.task }),
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5
        },
        cost: {
          estimatedCost: 0.001,
          currency: "USD"
        },
        latencyMs: 1
      };
    }
  };
}
