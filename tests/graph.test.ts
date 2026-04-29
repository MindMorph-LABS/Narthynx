import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createDeterministicPlanGraph, planGraphSchema, readPlanGraph, writePlanGraph } from "../src/missions/graph";
import type { Mission } from "../src/missions/schema";

async function tempGraphPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "narthynx-graph-"));
  return path.join(dir, "graph.json");
}

function missionFixture(): Mission {
  const now = new Date().toISOString();
  return {
    id: "m_123e4567-e89b-12d3-a456-426614174000",
    title: "Prepare launch checklist",
    goal: "Prepare my launch checklist",
    successCriteria: ["Mission goal is satisfied."],
    context: {
      notes: [],
      files: []
    },
    planGraph: {
      nodes: [],
      edges: []
    },
    state: "created",
    riskProfile: {
      level: "low",
      reasons: ["Initial mission has no actions yet."]
    },
    checkpoints: [],
    approvals: [],
    artifacts: [],
    ledger: [],
    createdAt: now,
    updatedAt: now
  };
}

describe("plan graph", () => {
  it("accepts the deterministic MVP graph", () => {
    const graph = createDeterministicPlanGraph(missionFixture(), "2026-01-01T00:00:00.000Z");

    expect(planGraphSchema.safeParse(graph).success).toBe(true);
    expect(graph.nodes).toHaveLength(6);
    expect(graph.edges).toHaveLength(5);
    expect(graph.nodes.map((node) => node.title)).toEqual([
      "Understand goal",
      "Inspect workspace",
      "Gather relevant context",
      "Propose artifact/action",
      "Request approval before writing",
      "Generate final report"
    ]);
  });

  it("rejects invalid node types", () => {
    const graph = createDeterministicPlanGraph(missionFixture(), "2026-01-01T00:00:00.000Z");

    const result = planGraphSchema.safeParse({
      ...graph,
      nodes: [
        {
          ...graph.nodes[0],
          type: "chat"
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it("rejects broken edge references", () => {
    const graph = createDeterministicPlanGraph(missionFixture(), "2026-01-01T00:00:00.000Z");

    const result = planGraphSchema.safeParse({
      ...graph,
      edges: [{ from: "n_missing", to: graph.nodes[0]?.id }]
    });

    expect(result.success).toBe(false);
  });

  it("writes and reads graph.json", async () => {
    const filePath = await tempGraphPath();
    const graph = createDeterministicPlanGraph(missionFixture(), "2026-01-01T00:00:00.000Z");

    await writePlanGraph(filePath, graph);

    await expect(readPlanGraph(filePath)).resolves.toEqual(graph);
  });
});
