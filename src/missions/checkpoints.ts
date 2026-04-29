import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";
import { z } from "zod";

import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { resolveGuardedWorkspacePath } from "../tools/path-guard";
import { createCheckpointId } from "../utils/ids";
import type { ApprovalRequest } from "./approvals";
import { appendLedgerEvent, ledgerFilePath } from "./ledger";
import { missionDirectory, missionFilePath } from "./store";

export const CHECKPOINTS_DIR_NAME = "checkpoints";

const filesystemWriteInputSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

export const checkpointSchema = z.object({
  id: z.string().regex(/^c_[a-z0-9_-]+$/),
  missionId: z.string().regex(/^m_[a-z0-9_-]+$/),
  approvalId: z.string().regex(/^a_[a-z0-9_-]+$/),
  toolName: z.string().min(1),
  targetPath: z.string().min(1),
  existedBefore: z.boolean(),
  snapshotContent: z.string().optional(),
  actionInput: z.unknown(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  restoredAt: z.string().datetime().optional()
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

export interface CheckpointStore {
  createFilesystemWriteCheckpoint(approval: ApprovalRequest): Promise<Checkpoint>;
  readCheckpoint(missionId: string, checkpointId: string): Promise<Checkpoint>;
  rewindCheckpoint(missionId: string, checkpointId: string): Promise<{ checkpoint: Checkpoint; fileRollback: boolean; message: string }>;
}

export function checkpointsDirPath(missionDir: string): string {
  return path.join(missionDir, CHECKPOINTS_DIR_NAME);
}

export function checkpointFilePath(missionDir: string, checkpointId: string): string {
  return path.join(checkpointsDirPath(missionDir), `${checkpointId}.json`);
}

export function createCheckpointStore(cwd = process.cwd()): CheckpointStore {
  const paths = resolveWorkspacePaths(cwd);

  return {
    async createFilesystemWriteCheckpoint(approval) {
      const input = filesystemWriteInputSchema.parse(approval.toolInput);
      const policy = await loadWorkspacePolicy(paths.policyFile);
      if (!policy.ok) {
        throw new Error(`policy.yaml invalid: ${policy.message}`);
      }

      const guarded = resolveGuardedWorkspacePath(paths.rootDir, input.path, policy.value);
      const existing = await stat(guarded.absolutePath).catch(() => undefined);
      if (existing?.isDirectory()) {
        throw new Error(`Cannot checkpoint directory target for filesystem.write: ${input.path}`);
      }

      const now = new Date().toISOString();
      const checkpoint = checkpointSchema.parse({
        id: createCheckpointId(),
        missionId: approval.missionId,
        approvalId: approval.id,
        toolName: approval.toolName,
        targetPath: guarded.relativePath,
        existedBefore: Boolean(existing?.isFile()),
        snapshotContent: existing?.isFile() ? await readFile(guarded.absolutePath, "utf8") : undefined,
        actionInput: approval.toolInput,
        createdAt: now,
        updatedAt: now
      });

      await writeCheckpoint(paths.missionsDir, checkpoint);
      await mirrorMissionCheckpoints(paths.missionsDir, checkpoint.missionId);
      await appendLedgerEvent(ledgerFilePath(missionDirectory(paths.missionsDir, checkpoint.missionId)), {
        missionId: checkpoint.missionId,
        type: "checkpoint.created",
        summary: `Checkpoint created for ${checkpoint.toolName}: ${checkpoint.targetPath}`,
        details: {
          checkpointId: checkpoint.id,
          approvalId: checkpoint.approvalId,
          targetPath: checkpoint.targetPath,
          existedBefore: checkpoint.existedBefore
        },
        timestamp: checkpoint.createdAt
      });

      return checkpoint;
    },

    async readCheckpoint(missionId, checkpointId) {
      return readCheckpointFile(checkpointFilePath(missionDirectory(paths.missionsDir, missionId), checkpointId));
    },

    async rewindCheckpoint(missionId, checkpointId) {
      const checkpoint = await this.readCheckpoint(missionId, checkpointId);
      const policy = await loadWorkspacePolicy(paths.policyFile);
      if (!policy.ok) {
        throw new Error(`policy.yaml invalid: ${policy.message}`);
      }

      const guarded = resolveGuardedWorkspacePath(paths.rootDir, checkpoint.targetPath, policy.value);
      if (checkpoint.existedBefore) {
        await mkdir(path.dirname(guarded.absolutePath), { recursive: true });
        await writeFile(guarded.absolutePath, checkpoint.snapshotContent ?? "", "utf8");
      } else {
        await rm(guarded.absolutePath, { force: true });
      }

      const now = new Date().toISOString();
      const restored = checkpointSchema.parse({
        ...checkpoint,
        updatedAt: now,
        restoredAt: now
      });
      await writeCheckpoint(paths.missionsDir, restored);
      await mirrorMissionCheckpoints(paths.missionsDir, missionId);
      await appendLedgerEvent(ledgerFilePath(missionDirectory(paths.missionsDir, missionId)), {
        missionId,
        type: "user.note",
        summary: `Checkpoint rewound: ${checkpointId}`,
        details: {
          checkpointId,
          targetPath: restored.targetPath,
          fileRollback: true,
          restoredAt: now
        },
        timestamp: now
      });

      return {
        checkpoint: restored,
        fileRollback: true,
        message: checkpoint.existedBefore
          ? `Restored previous file content for ${restored.targetPath}.`
          : `Removed file created by checkpoint ${checkpointId}: ${restored.targetPath}.`
      };
    }
  };
}

async function readCheckpointFile(filePath: string): Promise<Checkpoint> {
  try {
    const parsed = checkpointSchema.safeParse(JSON.parse(await readFile(filePath, "utf8")));
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }

    return parsed.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown checkpoint read failure";
    throw new Error(`Failed to read checkpoint at ${filePath}: ${message}`);
  }
}

async function writeCheckpoint(missionsDir: string, checkpoint: Checkpoint): Promise<void> {
  const missionDir = missionDirectory(missionsDir, checkpoint.missionId);
  await mkdir(checkpointsDirPath(missionDir), { recursive: true });
  await writeFile(checkpointFilePath(missionDir, checkpoint.id), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

async function mirrorMissionCheckpoints(missionsDir: string, missionId: string): Promise<void> {
  const missionDir = missionDirectory(missionsDir, missionId);
  const checkpointDir = checkpointsDirPath(missionDir);
  const entries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(checkpointDir, { withFileTypes: true }).catch(() => [])
  );
  const checkpoints = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readCheckpointFile(path.join(checkpointDir, entry.name)))
  );
  const summaries = checkpoints
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((checkpoint) => ({
      id: checkpoint.id,
      approvalId: checkpoint.approvalId,
      toolName: checkpoint.toolName,
      targetPath: checkpoint.targetPath,
      existedBefore: checkpoint.existedBefore,
      createdAt: checkpoint.createdAt,
      restoredAt: checkpoint.restoredAt
    }));
  const filePath = missionFilePath(missionsDir, missionId);
  const raw = await readFile(filePath, "utf8");
  const mission = YAML.parse(raw) as Record<string, unknown>;
  mission.checkpoints = summaries;
  mission.updatedAt = new Date().toISOString();
  await writeFile(filePath, YAML.stringify(mission), "utf8");
}
