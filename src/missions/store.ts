import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { resolveWorkspacePaths } from "../config/workspace";
import { createMissionId } from "../utils/ids";
import {
  createDeterministicPlanGraph,
  graphFilePath,
  readPlanGraph,
  updatePlanGraphNodeStatus,
  writePlanGraph,
  type MissionNodeStatus,
  type PlanGraph
} from "./graph";
import { graphViewFilePath, graphViewFileSchema, type GraphViewFile } from "./graph-view-persist";
import { appendLedgerEvent, ledgerFilePath, readLedgerEvents, type LedgerEvent } from "./ledger";
import { missionSchema, type CreateMissionInput, type Mission, type MissionState } from "./schema";
import { assertMissionStateTransition } from "./state-machine";

const MISSION_FILE_NAME = "mission.yaml";

export interface MissionStore {
  createMission(input: CreateMissionInput): Promise<Mission>;
  readMission(id: string): Promise<Mission>;
  listMissions(): Promise<Mission[]>;
  updateMissionState(id: string, state: MissionState): Promise<Mission>;
  readMissionLedger(id: string, options?: { allowMissing?: boolean }): Promise<LedgerEvent[]>;
  ensureMissionPlanGraph(id: string): Promise<PlanGraph>;
  readMissionPlanGraph(id: string): Promise<PlanGraph>;
  updateMissionPlanGraph(
    id: string,
    graph: PlanGraph,
    details?: { summary?: string; provider?: string; model?: string }
  ): Promise<PlanGraph>;
  updateMissionPlanNodeStatus(id: string, nodeId: string, status: MissionNodeStatus): Promise<PlanGraph>;
  readGraphView(id: string): Promise<GraphViewFile | null>;
  mergeGraphViewPositions(id: string, positions: Record<string, { x: number; y: number }>): Promise<GraphViewFile>;
}

export function createMissionStore(cwd = process.cwd()): MissionStore {
  const paths = resolveWorkspacePaths(cwd);

  return {
    async createMission(input) {
      await assertWorkspaceReady(paths);
      const goal = input.goal.trim();
      if (goal.length === 0) {
        throw new Error("Mission goal is required.");
      }

      const now = new Date().toISOString();
      const baseMission: Mission = {
        id: createMissionId(),
        title: normalizeTitle(input.title ?? goal),
        goal,
        successCriteria:
          input.successCriteria && input.successCriteria.length > 0 ? input.successCriteria : ["Mission goal is satisfied."],
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
          level: input.riskProfile?.level ?? "low",
          reasons: input.riskProfile?.reasons ?? ["Initial mission has no actions yet."]
        },
        checkpoints: [],
        approvals: [],
        artifacts: [],
        ledger: [],
        createdAt: now,
        updatedAt: now
      };
      const graph = createDeterministicPlanGraph(baseMission, now);
      const mission: Mission = {
        ...baseMission,
        planGraph: graph
      };

      const parsed = missionSchema.parse(mission);
      const missionDir = missionDirectory(paths.missionsDir, parsed.id);
      await mkdir(missionDir, { recursive: true });
      await writeMissionFile(missionDir, parsed);
      await writePlanGraph(graphFilePath(missionDir), graph);
      await appendLedgerEvent(ledgerFilePath(missionDir), {
        missionId: parsed.id,
        type: "mission.created",
        summary: `Mission created: ${parsed.title}`,
        details: {
          title: parsed.title,
          goal: parsed.goal,
          state: parsed.state,
          templateName: input.templateName
        },
        timestamp: parsed.createdAt
      });
      await appendLedgerEvent(ledgerFilePath(missionDir), {
        missionId: parsed.id,
        type: "plan.created",
        summary: "Deterministic MVP plan graph created.",
        details: {
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          templateName: input.templateName
        },
        timestamp: graph.createdAt
      });

      return parsed;
    },

    async readMission(id) {
      await assertWorkspaceReady(paths);
      return readMissionFromFile(missionFilePath(paths.missionsDir, id));
    },

    async listMissions() {
      await assertWorkspaceReady(paths);
      const entries = await readdir(paths.missionsDir, { withFileTypes: true });

      const missions = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => readMissionFromFile(path.join(paths.missionsDir, entry.name, MISSION_FILE_NAME)))
      );

      return missions.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },

    async updateMissionState(id, state) {
      const mission = await this.readMission(id);
      assertMissionStateTransition(mission.state, state);
      const previousState = mission.state;

      const updated: Mission = {
        ...mission,
        state,
        updatedAt: new Date().toISOString()
      };

      const parsed = missionSchema.parse(updated);
      const missionDir = missionDirectory(paths.missionsDir, id);
      await writeMissionFile(missionDir, parsed);
      await appendLedgerEvent(ledgerFilePath(missionDir), {
        missionId: parsed.id,
        type: "mission.state_changed",
        summary: `Mission state changed: ${previousState} -> ${state}`,
        details: {
          from: previousState,
          to: state
        },
        timestamp: parsed.updatedAt
      });

      if (state === "completed" && !hasReportArtifact(parsed)) {
        const { createReportService } = await import("./reports");
        await createReportService(paths.rootDir).generateMissionReport(id);
      }

      return parsed;
    },

    async readMissionLedger(id, options = {}) {
      await this.readMission(id);
      return readLedgerEvents(ledgerFilePath(missionDirectory(paths.missionsDir, id)), options);
    },

    async ensureMissionPlanGraph(id) {
      const mission = await this.readMission(id);
      const missionDir = missionDirectory(paths.missionsDir, id);
      const filePath = graphFilePath(missionDir);

      try {
        const graph = await readPlanGraph(filePath);
        if (JSON.stringify(mission.planGraph) !== JSON.stringify(graph)) {
          const updated = missionSchema.parse({
            ...mission,
            planGraph: graph,
            updatedAt: new Date().toISOString()
          });
          await writeMissionFile(missionDir, updated);
        }

        return graph;
      } catch (error) {
        if (!isMissingGraphError(error)) {
          throw error;
        }

        const now = new Date().toISOString();
        const graph = createDeterministicPlanGraph(mission, now);
        await writePlanGraph(filePath, graph);
        const updated = missionSchema.parse({
          ...mission,
          planGraph: graph,
          updatedAt: now
        });
        await writeMissionFile(missionDir, updated);
        await appendLedgerEvent(ledgerFilePath(missionDir), {
          missionId: mission.id,
          type: "plan.created",
          summary: "Deterministic MVP plan graph created.",
          details: {
            nodeCount: graph.nodes.length,
            edgeCount: graph.edges.length,
            backfilled: true
          },
          timestamp: graph.createdAt
        });

        return graph;
      }
    },

    async readMissionPlanGraph(id) {
      await this.readMission(id);
      return readPlanGraph(graphFilePath(missionDirectory(paths.missionsDir, id)));
    },

    async updateMissionPlanGraph(id, graph, details = {}) {
      const mission = await this.readMission(id);
      const missionDir = missionDirectory(paths.missionsDir, id);
      const now = new Date().toISOString();
      const parsedGraph = await writePlanGraph(graphFilePath(missionDir), {
        ...graph,
        missionId: id,
        updatedAt: now
      });
      const updated = missionSchema.parse({
        ...mission,
        planGraph: parsedGraph,
        updatedAt: now
      });
      await writeMissionFile(missionDir, updated);
      await appendLedgerEvent(ledgerFilePath(missionDir), {
        missionId: id,
        type: "plan.updated",
        summary: details.summary ?? "Mission plan graph updated.",
        details: {
          nodeCount: parsedGraph.nodes.length,
          edgeCount: parsedGraph.edges.length,
          provider: details.provider,
          model: details.model
        },
        timestamp: now
      });

      return parsedGraph;
    },

    async updateMissionPlanNodeStatus(id, nodeId, status) {
      const mission = await this.readMission(id);
      const missionDir = missionDirectory(paths.missionsDir, id);
      const currentGraph = await readPlanGraph(graphFilePath(missionDir));
      const graph = updatePlanGraphNodeStatus(currentGraph, nodeId, status);
      const parsedGraph = await writePlanGraph(graphFilePath(missionDir), graph);
      const updated = missionSchema.parse({
        ...mission,
        planGraph: parsedGraph,
        updatedAt: parsedGraph.updatedAt
      });
      await writeMissionFile(missionDir, updated);

      return parsedGraph;
    },

    async readGraphView(id) {
      await this.readMission(id);
      const missionDir = missionDirectory(paths.missionsDir, id);
      const fp = graphViewFilePath(missionDir);
      try {
        const raw = await readFile(fp, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        return graphViewFileSchema.parse(parsed);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "";
        if (code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async mergeGraphViewPositions(id, positions) {
      await this.readMission(id);
      const plan = await this.readMissionPlanGraph(id);
      const valid = new Set(plan.nodes.map((n) => n.id));
      const existing = await this.readGraphView(id);
      const merged: Record<string, { x: number; y: number }> = { ...(existing?.positions ?? {}) };
      for (const [nodeId, pos] of Object.entries(positions)) {
        if (!valid.has(nodeId)) {
          continue;
        }
        if (typeof pos?.x === "number" && typeof pos?.y === "number") {
          merged[nodeId] = { x: pos.x, y: pos.y };
        }
      }
      const file = graphViewFileSchema.parse({ version: 1, positions: merged });
      const missionDir = missionDirectory(paths.missionsDir, id);
      await mkdir(missionDir, { recursive: true });
      await writeFile(graphViewFilePath(missionDir), `${JSON.stringify(file, null, 2)}\n`, "utf8");
      return file;
    }
  };
}

async function assertWorkspaceReady(paths: ReturnType<typeof resolveWorkspacePaths>): Promise<void> {
  const checks = await Promise.all([
    pathExistsAsDirectory(paths.workspaceDir),
    pathExistsAsFile(paths.configFile),
    pathExistsAsFile(paths.policyFile),
    pathExistsAsDirectory(paths.missionsDir)
  ]);

  if (checks.some((ok) => !ok)) {
    throw new Error("Workspace is not initialized. Run: narthynx init");
  }
}

async function pathExistsAsDirectory(targetPath: string): Promise<boolean> {
  const existing = await stat(targetPath).catch(() => undefined);
  return Boolean(existing?.isDirectory());
}

async function pathExistsAsFile(targetPath: string): Promise<boolean> {
  const existing = await stat(targetPath).catch(() => undefined);
  return Boolean(existing?.isFile());
}

export function missionDirectory(missionsDir: string, id: string): string {
  return path.join(missionsDir, id);
}

export function missionFilePath(missionsDir: string, id: string): string {
  return path.join(missionDirectory(missionsDir, id), MISSION_FILE_NAME);
}

async function readMissionFromFile(filePath: string): Promise<Mission> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = missionSchema.safeParse(YAML.parse(raw));

    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }

    return parsed.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown mission read failure";
    throw new Error(`Failed to read mission at ${filePath}: ${message}`);
  }
}

async function writeMissionFile(missionDir: string, mission: Mission): Promise<void> {
  await mkdir(missionDir, { recursive: true });
  await writeFile(path.join(missionDir, MISSION_FILE_NAME), YAML.stringify(mission), "utf8");
}

function normalizeTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 72) {
    return trimmed;
  }

  return `${trimmed.slice(0, 69)}...`;
}

function isMissingGraphError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ENOENT");
}

function hasReportArtifact(mission: Mission): boolean {
  return mission.artifacts.some((artifact) => {
    if (typeof artifact !== "object" || artifact === null) {
      return false;
    }

    const value = artifact as { type?: unknown; path?: unknown };
    return value.type === "report" && value.path === "artifacts/report.md";
  });
}
