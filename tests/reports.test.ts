import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { initWorkspace } from "../src/config/workspace";
import { artifactSchema } from "../src/missions/artifacts";
import { createApprovalStore } from "../src/missions/approvals";
import { createReportService } from "../src/missions/reports";
import { createMissionStore } from "../src/missions/store";
import { createToolRunner } from "../src/tools/runner";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-reports-"));
}

describe("report artifacts", () => {
  it("accepts valid report artifacts and rejects malformed IDs", () => {
    const now = new Date().toISOString();
    const valid = artifactSchema.safeParse({
      id: "art_123e4567-e89b-12d3-a456-426614174000",
      missionId: "m_123e4567-e89b-12d3-a456-426614174000",
      type: "report",
      path: "artifacts/report.md",
      title: "Mission report",
      createdAt: now,
      updatedAt: now
    });
    const invalid = artifactSchema.safeParse({
      id: "bad",
      missionId: "bad",
      type: "other"
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it("generates a deterministic report with required sections and registered artifact", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "Prepare launch checklist" });
    const runner = createToolRunner({ cwd });
    await runner.runTool({
      missionId: mission.id,
      toolName: "filesystem.list",
      input: { path: "." }
    });

    const result = await createReportService(cwd).generateMissionReport(mission.id);
    const report = await readFile(result.path, "utf8");
    const updatedMission = await missionStore.readMission(mission.id);
    const ledger = await missionStore.readMissionLedger(mission.id);

    expect(result.regenerated).toBe(false);
    expect(result.artifact.id).toMatch(/^art_/);
    expect(report).toContain("# Prepare launch checklist");
    expect(report).toContain("## Goal");
    expect(report).toContain("## Success Criteria");
    expect(report).toContain("## Final Status");
    expect(report).toContain("## Plan Summary");
    expect(report).toContain("## Actions Performed");
    expect(report).toContain("## Approvals Requested And Outcomes");
    expect(report).toContain("## Files/Artifacts Created");
    expect(report).toContain("## Risks Encountered");
    expect(report).toContain("## Failures/Recoveries");
    expect(report).toContain("## Limitations");
    expect(report).toContain("## Next Recommended Actions");
    expect(report).toContain("tool.completed");
    expect(updatedMission.artifacts).toEqual([
      expect.objectContaining({
        id: result.artifact.id,
        path: "artifacts/report.md",
        type: "report"
      })
    ]);
    expect(ledger.at(-1)?.type).toBe("artifact.created");
  });

  it("regenerates the same report artifact without adding unrelated files", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "Prepare launch checklist" });
    const service = createReportService(cwd);
    const first = await service.generateMissionReport(mission.id);
    const second = await service.generateMissionReport(mission.id);
    const updatedMission = await missionStore.readMission(mission.id);

    expect(second.regenerated).toBe(true);
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(updatedMission.artifacts).toHaveLength(1);
    await expect(readFile(path.join(cwd, ".narthynx", "missions", mission.id, "artifacts", "report.md"), "utf8")).resolves.toContain(
      "## Limitations"
    );
  });

  it("includes approvals and checkpoints in generated reports", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const missionStore = createMissionStore(cwd);
    const approvalStore = createApprovalStore(cwd);
    const mission = await missionStore.createMission({ goal: "Prepare launch checklist" });
    const runner = createToolRunner({ cwd });
    const requested = await runner.runTool({
      missionId: mission.id,
      toolName: "filesystem.write",
      input: { path: "launch.md", content: "ready\n" }
    });
    const approvalId = requested.ok ? "" : requested.approvalId ?? "";
    await approvalStore.decideApproval(approvalId, "approved");
    const executed = await runner.runApprovedTool(approvalId);

    const result = await createReportService(cwd).generateMissionReport(mission.id);
    const report = await readFile(result.path, "utf8");

    expect(executed.ok).toBe(true);
    expect(report).toContain(approvalId);
    if (executed.ok) {
      expect(report).toContain(executed.checkpointId);
    }
  });

  it("generates a report automatically when a mission is completed without one", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "Prepare launch checklist" });

    await missionStore.updateMissionState(mission.id, "planning");
    await missionStore.updateMissionState(mission.id, "running");
    await missionStore.updateMissionState(mission.id, "verifying");
    await missionStore.updateMissionState(mission.id, "completed");

    const reportPath = path.join(cwd, ".narthynx", "missions", mission.id, "artifacts", "report.md");
    const updated = await missionStore.readMission(mission.id);
    const ledger = await missionStore.readMissionLedger(mission.id);

    await expect(readFile(reportPath, "utf8")).resolves.toContain("State: completed");
    expect(updated.artifacts).toEqual([
      expect.objectContaining({
        type: "report",
        path: "artifacts/report.md"
      })
    ]);
    expect(ledger.at(-1)?.type).toBe("artifact.created");
  });
});
