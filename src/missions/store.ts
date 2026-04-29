import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { resolveWorkspacePaths } from "../config/workspace";
import { createMissionId } from "../utils/ids";
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
      const mission: Mission = {
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

      const parsed = missionSchema.parse(mission);
      const missionDir = missionDirectory(paths.missionsDir, parsed.id);
      await mkdir(missionDir, { recursive: true });
      await writeMissionFile(missionDir, parsed);
      await appendLedgerEvent(ledgerFilePath(missionDir), {
        missionId: parsed.id,
        type: "mission.created",
        summary: `Mission created: ${parsed.title}`,
        details: {
          title: parsed.title,
          goal: parsed.goal,
          state: parsed.state
        },
        timestamp: parsed.createdAt
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

      return parsed;
    },

    async readMissionLedger(id, options = {}) {
      await this.readMission(id);
      return readLedgerEvents(ledgerFilePath(missionDirectory(paths.missionsDir, id)), options);
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
