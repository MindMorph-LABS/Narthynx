import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { initWorkspace } from "../src/config/workspace";
import { missionSchema, type Mission } from "../src/missions/schema";
import { createMissionStore, missionFilePath } from "../src/missions/store";
import { assertMissionStateTransition, canTransitionMissionState } from "../src/missions/state-machine";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-missions-"));
}

function validMission(overrides: Partial<Mission> = {}): Mission {
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
    updatedAt: now,
    ...overrides
  };
}

describe("mission schema", () => {
  it("accepts a valid mission", () => {
    const parsed = missionSchema.safeParse(validMission());

    expect(parsed.success).toBe(true);
  });

  it("rejects missing required fields and invalid states", () => {
    const missingGoal = missionSchema.safeParse({
      ...validMission(),
      goal: undefined
    });
    const invalidState = missionSchema.safeParse({
      ...validMission(),
      state: "done"
    });

    expect(missingGoal.success).toBe(false);
    expect(invalidState.success).toBe(false);
  });
});

describe("mission state machine", () => {
  it("allows documented transitions", () => {
    expect(canTransitionMissionState("created", "planning")).toBe(true);
    expect(canTransitionMissionState("planning", "running")).toBe(true);
    expect(canTransitionMissionState("running", "waiting_for_approval")).toBe(true);
    expect(canTransitionMissionState("waiting_for_approval", "running")).toBe(true);
    expect(canTransitionMissionState("running", "failed")).toBe(true);
    expect(canTransitionMissionState("failed", "recovering")).toBe(true);
    expect(canTransitionMissionState("recovering", "running")).toBe(true);
    expect(canTransitionMissionState("running", "paused")).toBe(true);
    expect(canTransitionMissionState("paused", "running")).toBe(true);
    expect(canTransitionMissionState("running", "verifying")).toBe(true);
    expect(canTransitionMissionState("verifying", "completed")).toBe(true);
    expect(canTransitionMissionState("created", "cancelled")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(() => assertMissionStateTransition("created", "completed")).toThrow(
      "Invalid mission state transition: created -> completed"
    );
  });
});

describe("mission store", () => {
  it("creates a mission.yaml file", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "Prepare my launch checklist" });
    const raw = await readFile(path.join(cwd, ".narthynx", "missions", mission.id, "mission.yaml"), "utf8");

    expect(mission.id).toMatch(/^m_/);
    expect(mission.state).toBe("created");
    expect(raw).toContain("Prepare my launch checklist");
  });

  it("reads missions after creating a fresh store instance", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const firstStore = createMissionStore(cwd);
    const created = await firstStore.createMission({ goal: "Prepare my launch checklist" });
    const secondStore = createMissionStore(cwd);
    const read = await secondStore.readMission(created.id);

    expect(read).toEqual(created);
  });

  it("lists missions sorted by created time", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const store = createMissionStore(cwd);
    const later = await store.createMission({ goal: "Second mission" });
    const earlier = await store.createMission({ goal: "First mission" });
    const earlierPath = missionFilePath(path.join(cwd, ".narthynx", "missions"), earlier.id);
    await writeFile(
      earlierPath,
      YAML.stringify({
        ...earlier,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }),
      "utf8"
    );

    const missions = await store.listMissions();

    expect(missions.map((mission) => mission.id)).toEqual([earlier.id, later.id]);
  });

  it("persists valid state transitions and rejects invalid transitions", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "Prepare my launch checklist" });
    const updated = await store.updateMissionState(mission.id, "planning");

    expect(updated.state).toBe("planning");
    await expect(store.updateMissionState(mission.id, "completed")).rejects.toThrow(
      "Invalid mission state transition: planning -> completed"
    );
  });

  it("requires an initialized workspace", async () => {
    const cwd = await tempWorkspaceRoot();
    const store = createMissionStore(cwd);

    await expect(store.createMission({ goal: "Prepare my launch checklist" })).rejects.toThrow(
      "Workspace is not initialized. Run: narthynx init"
    );
  });

  it("reports malformed mission files with path and validation reason", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const missionDir = path.join(cwd, ".narthynx", "missions", "m_bad");
    await mkdir(missionDir, { recursive: true });
    await writeFile(path.join(missionDir, "mission.yaml"), "id: m_bad\nstate: bogus\n", "utf8");

    const store = createMissionStore(cwd);

    await expect(store.readMission("m_bad")).rejects.toThrow("Failed to read mission at");
    await expect(store.readMission("m_bad")).rejects.toThrow("state");
  });
});
