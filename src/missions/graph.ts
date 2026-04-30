import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { Mission } from "./schema";

export const GRAPH_FILE_NAME = "graph.json";

export const missionNodeTypeSchema = z.enum([
  "research",
  "action",
  "approval",
  "verification",
  "recovery",
  "handoff",
  "artifact"
]);

export const missionNodeStatusSchema = z.enum(["pending", "blocked", "ready", "completed", "failed"]);

export const missionNodeSchema = z.object({
  id: z.string().min(1),
  type: missionNodeTypeSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  status: missionNodeStatusSchema
});

export const missionEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1)
});

export const planGraphSchema = z
  .object({
    missionId: z.string().regex(/^m_[a-z0-9_-]+$/),
    version: z.literal(1),
    nodes: z.array(missionNodeSchema).min(1),
    edges: z.array(missionEdgeSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .superRefine((graph, context) => {
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    for (const [index, edge] of graph.edges.entries()) {
      if (!nodeIds.has(edge.from)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index, "from"],
          message: `Unknown edge source node: ${edge.from}`
        });
      }

      if (!nodeIds.has(edge.to)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index, "to"],
          message: `Unknown edge target node: ${edge.to}`
        });
      }
    }
  });

export type MissionNodeType = z.infer<typeof missionNodeTypeSchema>;
export type MissionNodeStatus = z.infer<typeof missionNodeStatusSchema>;
export type MissionNode = z.infer<typeof missionNodeSchema>;
export type MissionEdge = z.infer<typeof missionEdgeSchema>;
export type PlanGraph = z.infer<typeof planGraphSchema>;

export function graphFilePath(missionDir: string): string {
  return path.join(missionDir, GRAPH_FILE_NAME);
}

export function createDeterministicPlanGraph(mission: Mission, timestamp = new Date().toISOString()): PlanGraph {
  return planGraphSchema.parse({
    missionId: mission.id,
    version: 1,
    nodes: [
      {
        id: "n_001_understand_goal",
        type: "research",
        title: "Understand goal",
        description: `Clarify the mission goal: ${mission.goal}`,
        status: "pending"
      },
      {
        id: "n_002_inspect_workspace",
        type: "research",
        title: "Inspect workspace",
        description: "Review local project structure and available workspace context without executing risky actions.",
        status: "pending"
      },
      {
        id: "n_003_gather_context",
        type: "research",
        title: "Gather relevant context",
        description: "Collect the files, notes, and constraints needed to reason about the mission.",
        status: "pending"
      },
      {
        id: "n_004_propose_artifact_or_action",
        type: "action",
        title: "Propose artifact/action",
        description: "Draft the proposed useful output or next action before changing local state.",
        status: "pending"
      },
      {
        id: "n_005_request_approval",
        type: "approval",
        title: "Request approval before writing",
        description: "Pause for explicit human approval before any local write or other non-trivial side effect.",
        status: "pending"
      },
      {
        id: "n_006_generate_report",
        type: "artifact",
        title: "Generate final report",
        description: "Create a durable report summarizing the mission outcome, limitations, and next actions.",
        status: "pending"
      }
    ],
    edges: [
      { from: "n_001_understand_goal", to: "n_002_inspect_workspace" },
      { from: "n_002_inspect_workspace", to: "n_003_gather_context" },
      { from: "n_003_gather_context", to: "n_004_propose_artifact_or_action" },
      { from: "n_004_propose_artifact_or_action", to: "n_005_request_approval" },
      { from: "n_005_request_approval", to: "n_006_generate_report" }
    ],
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function updatePlanGraphNodeStatus(graph: PlanGraph, nodeId: string, status: MissionNodeStatus): PlanGraph {
  const now = new Date().toISOString();
  const nodes = graph.nodes.map((node) => (node.id === nodeId ? { ...node, status } : node));

  if (!nodes.some((node) => node.id === nodeId)) {
    throw new Error(`Plan node not found: ${nodeId}`);
  }

  return planGraphSchema.parse({
    ...graph,
    nodes,
    updatedAt: now
  });
}

export async function writePlanGraph(filePath: string, graph: PlanGraph): Promise<PlanGraph> {
  const parsed = planGraphSchema.parse(graph);
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

export async function readPlanGraph(filePath: string): Promise<PlanGraph> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsedJson = JSON.parse(raw);
    const parsed = planGraphSchema.safeParse(parsedJson);

    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }

    return parsed.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown graph read failure";
    throw new Error(`Failed to read graph at ${filePath}: ${message}`);
  }
}
