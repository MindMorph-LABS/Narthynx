import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { initWorkspace } from "../src/config/workspace";
import { createApprovalStore } from "../src/missions/approvals";
import { checkpointSchema, createCheckpointStore } from "../src/missions/checkpoints";
import { createMissionStore } from "../src/missions/store";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-checkpoints-"));
}

async function initializedMission() {
  const cwd = await tempWorkspaceRoot();
  await initWorkspace(cwd);
  const missionStore = createMissionStore(cwd);
  const mission = await missionStore.createMission({ goal: "Prepare launch checklist" });

  return {
    cwd,
    mission,
    missionStore,
    approvalStore: createApprovalStore(cwd),
    checkpointStore: createCheckpointStore(cwd)
  };
}

describe("checkpoint schema", () => {
  it("accepts valid filesystem write checkpoints and rejects malformed IDs", () => {
    const now = new Date().toISOString();
    const valid = checkpointSchema.safeParse({
      id: "c_123e4567-e89b-12d3-a456-426614174000",
      missionId: "m_123e4567-e89b-12d3-a456-426614174000",
      approvalId: "a_123e4567-e89b-12d3-a456-426614174000",
      toolName: "filesystem.write",
      targetPath: "launch.md",
      existedBefore: true,
      snapshotContent: "before\n",
      actionInput: { path: "launch.md", content: "after\n" },
      createdAt: now,
      updatedAt: now
    });
    const invalid = checkpointSchema.safeParse({
      id: "bad",
      missionId: "bad",
      approvalId: "bad"
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });
});

describe("checkpoint store", () => {
  it("creates checkpoint JSON, mirrors mission checkpoints, and preserves previous file content", async () => {
    const { cwd, mission, missionStore, approvalStore, checkpointStore } = await initializedMission();
    await writeFile(path.join(cwd, "launch.md"), "before\n", "utf8");
    const approval = await approvalStore.createApproval({
      missionId: mission.id,
      toolName: "filesystem.write",
      toolInput: { path: "launch.md", content: "after\n" },
      riskLevel: "high",
      sideEffect: "local_write",
      reason: "Tool metadata requires approval."
    });

    const checkpoint = await checkpointStore.createFilesystemWriteCheckpoint(approval);
    const read = await checkpointStore.readCheckpoint(mission.id, checkpoint.id);
    const mirroredMission = await missionStore.readMission(mission.id);

    expect(checkpoint.id).toMatch(/^c_/);
    expect(read.snapshotContent).toBe("before\n");
    expect(mirroredMission.checkpoints).toEqual([
      expect.objectContaining({
        id: checkpoint.id,
        targetPath: "launch.md",
        existedBefore: true
      })
    ]);
  });

  it("rewinds existing files to their previous content", async () => {
    const { cwd, mission, approvalStore, checkpointStore } = await initializedMission();
    await writeFile(path.join(cwd, "launch.md"), "before\n", "utf8");
    const approval = await approvalStore.createApproval({
      missionId: mission.id,
      toolName: "filesystem.write",
      toolInput: { path: "launch.md", content: "after\n" },
      riskLevel: "high",
      sideEffect: "local_write",
      reason: "Tool metadata requires approval."
    });
    const checkpoint = await checkpointStore.createFilesystemWriteCheckpoint(approval);
    await writeFile(path.join(cwd, "launch.md"), "after\n", "utf8");

    const result = await checkpointStore.rewindCheckpoint(mission.id, checkpoint.id);

    expect(result.fileRollback).toBe(true);
    await expect(readFile(path.join(cwd, "launch.md"), "utf8")).resolves.toBe("before\n");
  });

  it("rewinds newly created files by removing them", async () => {
    const { cwd, mission, approvalStore, checkpointStore } = await initializedMission();
    const approval = await approvalStore.createApproval({
      missionId: mission.id,
      toolName: "filesystem.write",
      toolInput: { path: "launch.md", content: "after\n" },
      riskLevel: "high",
      sideEffect: "local_write",
      reason: "Tool metadata requires approval."
    });
    const checkpoint = await checkpointStore.createFilesystemWriteCheckpoint(approval);
    await writeFile(path.join(cwd, "launch.md"), "after\n", "utf8");

    await checkpointStore.rewindCheckpoint(mission.id, checkpoint.id);

    await expect(readFile(path.join(cwd, "launch.md"), "utf8")).rejects.toThrow();
  });

  it("blocks secret-like checkpoint targets", async () => {
    const { mission, approvalStore, checkpointStore } = await initializedMission();
    const approval = await approvalStore.createApproval({
      missionId: mission.id,
      toolName: "filesystem.write",
      toolInput: { path: ".env", content: "TOKEN=secret\n" },
      riskLevel: "high",
      sideEffect: "local_write",
      reason: "Tool metadata requires approval."
    });

    await expect(checkpointStore.createFilesystemWriteCheckpoint(approval)).rejects.toThrow("blocked by policy");
  });
});
