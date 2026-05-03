import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { initWorkspace } from "../src/config/workspace";
import { readLedgerEvents } from "../src/missions/ledger";
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
  it("creates mission.yaml, graph.json, and ledger.jsonl", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "Prepare my launch checklist" });
    const missionDir = path.join(cwd, ".narthynx", "missions", mission.id);
    const raw = await readFile(path.join(missionDir, "mission.yaml"), "utf8");
    const graphRaw = await readFile(path.join(missionDir, "graph.json"), "utf8");
    const ledger = await readLedgerEvents(path.join(missionDir, "ledger.jsonl"));
    const read = await store.readMission(mission.id);

    expect(mission.id).toMatch(/^m_/);
    expect(mission.state).toBe("created");
    expect(raw).toContain("Prepare my launch checklist");
    expect(graphRaw).toContain("Understand goal");
    expect(read.planGraph).toEqual(JSON.parse(graphRaw));
    expect(ledger[0]?.type).toBe("mission.created");
    expect(ledger[1]?.type).toBe("plan.created");
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
    const ledger = await store.readMissionLedger(mission.id);

    expect(updated.state).toBe("planning");
    expect(ledger.map((event) => event.type)).toEqual(["mission.created", "plan.created", "mission.state_changed"]);
    expect(ledger[2]?.details).toEqual({
      from: "created",
      to: "planning"
    });
    await expect(store.updateMissionState(mission.id, "completed")).rejects.toThrow(
      "Invalid mission state transition: planning -> completed"
    );
  });

  it("reads the same ledger after creating a fresh store instance", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const firstStore = createMissionStore(cwd);
    const mission = await firstStore.createMission({ goal: "Prepare my launch checklist" });
    await firstStore.updateMissionState(mission.id, "planning");

    const secondStore = createMissionStore(cwd);
    const ledger = await secondStore.readMissionLedger(mission.id);

    expect(ledger.map((event) => event.type)).toEqual(["mission.created", "plan.created", "mission.state_changed"]);
  });

  it("backfills a missing graph for older missions", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "Prepare my launch checklist" });
    const graphPath = path.join(cwd, ".narthynx", "missions", mission.id, "graph.json");
    await rm(graphPath, { force: true });

    const graph = await store.ensureMissionPlanGraph(mission.id);
    const updatedMission = await store.readMission(mission.id);
    const ledger = await store.readMissionLedger(mission.id);

    expect(graph.nodes).toHaveLength(6);
    expect(updatedMission.planGraph).toEqual(graph);
    expect(ledger.map((event) => event.type)).toEqual(["mission.created", "plan.created", "plan.created"]);
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

  it("persists graph-view positions and merges patches with last-write-wins per node", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "Layout persistence" });
    const graph = await store.readMissionPlanGraph(mission.id);
    const firstNodeId = graph.nodes[0].id;

    await store.mergeGraphViewPositions(mission.id, { [firstNodeId]: { x: 10, y: 20 } });
    const v1 = await store.readGraphView(mission.id);
    expect(v1?.positions[firstNodeId]).toEqual({ x: 10, y: 20 });

    await store.mergeGraphViewPositions(mission.id, { [firstNodeId]: { x: 99, y: 101 } });
    const v2 = await store.readGraphView(mission.id);
    expect(v2?.positions[firstNodeId]).toEqual({ x: 99, y: 101 });
  });
});
