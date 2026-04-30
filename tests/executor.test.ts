import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMissionExecutor } from "../src/agent/executor";
import { initWorkspace } from "../src/config/workspace";
import { createApprovalStore } from "../src/missions/approvals";
import { createMissionStore } from "../src/missions/store";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-executor-"));
}

async function initializedMission() {
  const cwd = await tempWorkspaceRoot();
  await initWorkspace(cwd);
  const store = createMissionStore(cwd);
  const mission = await store.createMission({ goal: "Prepare launch checklist" });

  return {
    cwd,
    store,
    mission,
    executor: createMissionExecutor(cwd),
    approvals: createApprovalStore(cwd)
  };
}

describe("mission executor", () => {
  it("runs deterministic nodes in order, persists graph progress, and pauses for approval", async () => {
    const { store, mission, executor } = await initializedMission();
    const result = await executor.runMission(mission.id);
    const updatedMission = await store.readMission(mission.id);
    const graph = await store.readMissionPlanGraph(mission.id);
    const ledger = await store.readMissionLedger(mission.id);

    expect(result.status).toBe("paused_for_approval");
    expect(result.approvalId).toMatch(/^a_/);
    expect(result.output).toContain("Completed node: Understand goal");
    expect(result.output).toContain("Completed node: Inspect workspace (filesystem.list)");
    expect(result.output).toContain("Paused for approval");
    expect(updatedMission.state).toBe("waiting_for_approval");
    expect(graph.nodes.map((node) => `${node.id}:${node.status}`)).toEqual([
      "n_001_understand_goal:completed",
      "n_002_inspect_workspace:completed",
      "n_003_gather_context:completed",
      "n_004_propose_artifact_or_action:completed",
      "n_005_request_approval:blocked",
      "n_006_generate_report:pending"
    ]);
    expect(ledger.map((event) => event.type)).toContain("node.started");
    expect(ledger.map((event) => event.type)).toContain("node.completed");
    expect(ledger.map((event) => event.type)).toContain("tool.requested");
    expect(ledger.at(-1)?.type).toBe("mission.state_changed");
  });

  it("does not duplicate approval requests while approval is pending", async () => {
    const { store, mission, executor, approvals } = await initializedMission();
    const first = await executor.runMission(mission.id);
    const second = await executor.runMission(mission.id);
    const missionApprovals = await approvals.listMissionApprovals(mission.id, { allowMissing: true });
    const ledger = await store.readMissionLedger(mission.id);
    const approvalEvents = ledger.filter((event) => event.type === "tool.denied" && event.details?.status === "pending_approval");

    expect(first.approvalId).toBe(second.approvalId);
    expect(approvalEvents).toHaveLength(1);
    expect(missionApprovals).toHaveLength(1);
  });

  it("resumes after approval, executes the approved action once, completes, and generates a final report", async () => {
    const { cwd, store, mission, executor, approvals } = await initializedMission();
    const started = await executor.runMission(mission.id);
    await approvals.decideApproval(started.approvalId ?? "", "approved");
    const resumed = await executor.resumeMission(mission.id);
    const completed = await store.readMission(mission.id);
    const graph = await store.readMissionPlanGraph(mission.id);
    const reportPath = path.join(cwd, ".narthynx", "missions", mission.id, "artifacts", "report.md");
    const report = await readFile(reportPath, "utf8");
    const rerun = await executor.runMission(mission.id);
    const ledger = await store.readMissionLedger(mission.id);

    expect(resumed.status).toBe("completed");
    expect(resumed.output).toContain("Mission completed");
    expect(completed.state).toBe("completed");
    expect(graph.nodes.every((node) => node.status === "completed")).toBe(true);
    expect(report).toContain("State: completed");
    expect(rerun.status).toBe("already_completed");
    expect(ledger.filter((event) => event.type === "tool.started" && event.details?.toolName === "report.write")).toHaveLength(1);
  });

  it("resumes after denial without executing the gated write and still completes with a report", async () => {
    const { cwd, store, mission, executor, approvals } = await initializedMission();
    const started = await executor.runMission(mission.id);
    await approvals.decideApproval(started.approvalId ?? "", "denied", "not needed");
    const resumed = await executor.resumeMission(mission.id);
    const completed = await store.readMission(mission.id);
    const reportPath = path.join(cwd, ".narthynx", "missions", mission.id, "artifacts", "report.md");
    const report = await readFile(reportPath, "utf8");
    const ledger = await store.readMissionLedger(mission.id);

    expect(resumed.status).toBe("completed");
    expect(completed.state).toBe("completed");
    expect(report).toContain("State: completed");
    expect(report).toContain("denied");
    expect(ledger.filter((event) => event.type === "tool.started" && event.details?.toolName === "report.write")).toHaveLength(0);
  });

  it("pauses and resumes mission state without corrupting pending approval state", async () => {
    const { store, mission, executor } = await initializedMission();
    const started = await executor.runMission(mission.id);
    const paused = await executor.pauseMission(mission.id);
    const resumed = await executor.resumeMission(mission.id);
    const afterResume = await store.readMission(mission.id);

    expect(started.status).toBe("paused_for_approval");
    expect(paused.status).toBe("paused");
    expect(paused.output).toContain("state: paused");
    expect(resumed.status).toBe("paused_for_approval");
    expect(afterResume.state).toBe("waiting_for_approval");
  });
});
