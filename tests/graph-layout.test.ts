import { describe, expect, it } from "vitest";

import { createDeterministicPlanGraph, planGraphSchema, type PlanGraph } from "../src/missions/graph";
import { computeDagrePositions } from "../src/missions/graph-layout";
import type { Mission } from "../src/missions/schema";

function missionFixture(): Mission {
  const now = new Date().toISOString();
  return {
    id: "m_snapshot_layout_test_0123456789ab",
    title: "Layout snapshot",
    goal: "Test dagre positions",
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

function roundPositions(pos: Record<string, { x: number; y: number }>): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const [k, v] of Object.entries(pos)) {
    out[k] = { x: Math.round(v.x), y: Math.round(v.y) };
  }
  return out;
}

describe("graph layout (dagre)", () => {
  it("produces stable rounded positions for the deterministic MVP graph", () => {
    const graph = createDeterministicPlanGraph(missionFixture(), "2026-01-01T00:00:00.000Z");
    expect(planGraphSchema.safeParse(graph).success).toBe(true);
    const pos = roundPositions(computeDagrePositions(graph));
    expect(pos).toMatchSnapshot();
  });

  it("layouts a simple fork (diamond-ish) without throwing", () => {
    const g: PlanGraph = {
      missionId: "m_fork",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [
        {
          id: "root",
          type: "research",
          title: "Root",
          description: "r",
          status: "pending"
        },
        {
          id: "left",
          type: "action",
          title: "Left",
          description: "l",
          status: "pending"
        },
        {
          id: "right",
          type: "action",
          title: "Right",
          description: "r",
          status: "pending"
        },
        {
          id: "join",
          type: "verification",
          title: "Join",
          description: "j",
          status: "pending"
        }
      ],
      edges: [
        { from: "root", to: "left" },
        { from: "root", to: "right" },
        { from: "left", to: "join" },
        { from: "right", to: "join" }
      ]
    };
    const pos = computeDagrePositions(g);
    expect(Object.keys(pos)).toHaveLength(4);
    for (const id of ["root", "left", "right", "join"]) {
      expect(pos[id]).toBeDefined();
      expect(Number.isFinite(pos[id]!.x)).toBe(true);
      expect(Number.isFinite(pos[id]!.y)).toBe(true);
    }
  });
});
