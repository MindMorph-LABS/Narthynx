import { describe, expect, it } from "vitest";

import { createDeterministicPlanGraph, planGraphSchema, type PlanGraph } from "../src/missions/graph";
import { buildGraphExecutionOverlay, computeFrontierNodeIds, shouldHighlightEdge } from "../src/missions/graph-view";
import { createLedgerEvent } from "../src/missions/ledger";
import type { Mission } from "../src/missions/schema";

function missionFixture(id = "m_graph_view_test"): Mission {
  const now = new Date().toISOString();
  return {
    id,
    title: "Graph view test",
    goal: "Overlay test",
    successCriteria: ["ok"],
    context: { notes: [], files: [] },
    planGraph: { nodes: [], edges: [] },
    state: "created",
    riskProfile: { level: "low", reasons: ["test"] },
    checkpoints: [],
    approvals: [],
    artifacts: [],
    ledger: [],
    createdAt: now,
    updatedAt: now
  };
}

describe("graph execution overlay", () => {
  it("marks all pending roots as frontier when nothing is completed", () => {
    const graph = createDeterministicPlanGraph(missionFixture(), "2026-01-01T00:00:00.000Z");
    expect(planGraphSchema.safeParse(graph).success).toBe(true);
    const frontier = computeFrontierNodeIds(graph);
    expect(frontier).toContain("n_001_understand_goal");
  });

  it("narrows frontier after first node completes", () => {
    const graph = createDeterministicPlanGraph(missionFixture(), "2026-01-01T00:00:00.000Z");
    const g: PlanGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === "n_001_understand_goal" ? { ...n, status: "completed" as const } : n
      )
    };
    const frontier = computeFrontierNodeIds(g);
    expect(frontier).not.toContain("n_001_understand_goal");
    expect(frontier).toContain("n_002_inspect_workspace");
  });

  it("records last ledger phase per node from node.* events", () => {
    const graph = createDeterministicPlanGraph(missionFixture(), "2026-01-01T00:00:00.000Z");
    const nid = graph.nodes[0].id;
    const ledger = [
      createLedgerEvent({
        missionId: graph.missionId,
        type: "node.started",
        summary: "start",
        details: { nodeId: nid }
      }),
      createLedgerEvent({
        missionId: graph.missionId,
        type: "node.completed",
        summary: "done",
        details: { nodeId: nid }
      })
    ];
    const overlay = buildGraphExecutionOverlay(graph, ledger);
    expect(overlay.byNodeId[nid]?.ledgerPhase).toBe("completed");
    expect(overlay.byNodeId[nid]?.lastLedgerEventType).toBe("node.completed");
  });

  it("highlights spine edge from completed node to frontier", () => {
    const graph = createDeterministicPlanGraph(missionFixture(), "2026-01-01T00:00:00.000Z");
    const g: PlanGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === "n_001_understand_goal" ? { ...n, status: "completed" as const } : n
      )
    };
    const frontier = new Set(computeFrontierNodeIds(g));
    const edge = g.edges.find((e) => e.from === "n_001_understand_goal" && e.to === "n_002_inspect_workspace");
    expect(edge).toBeDefined();
    expect(shouldHighlightEdge(g, edge!, frontier)).toBe(true);
  });
});
