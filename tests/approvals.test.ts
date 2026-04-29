import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_POLICY, defaultPolicyYaml } from "../src/config/defaults";
import { initWorkspace } from "../src/config/workspace";
import { approvalRequestSchema, createApprovalStore } from "../src/missions/approvals";
import { createMissionStore } from "../src/missions/store";
import { classifyToolPolicy } from "../src/tools/policy";
import { createToolRegistry } from "../src/tools/registry";
import type { ToolAction } from "../src/tools/types";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-approvals-"));
}

function tool(overrides: Partial<ToolAction<unknown, unknown>> = {}): ToolAction<unknown, unknown> {
  return {
    name: "example.tool",
    description: "Example tool",
    inputSchema: { safeParse: () => ({ success: true, data: {} }) } as ToolAction<unknown, unknown>["inputSchema"],
    outputSchema: { safeParse: () => ({ success: true, data: {} }) } as ToolAction<unknown, unknown>["outputSchema"],
    riskLevel: "low",
    sideEffect: "local_read",
    requiresApproval: false,
    reversible: true,
    async run() {
      return {};
    },
    ...overrides
  };
}

describe("approval schema and store", () => {
  it("accepts valid approvals and rejects malformed IDs/statuses", () => {
    const now = new Date().toISOString();

    expect(
      approvalRequestSchema.safeParse({
        id: "a_123e4567-e89b-12d3-a456-426614174000",
        missionId: "m_123e4567-e89b-12d3-a456-426614174000",
        toolName: "report.write",
        toolInput: { path: "report.md" },
        riskLevel: "medium",
        sideEffect: "local_write",
        status: "pending",
        reason: "Tool metadata requires approval.",
        prompt: "Action requires approval: report.write",
        createdAt: now,
        updatedAt: now
      }).success
    ).toBe(true);

    expect(approvalRequestSchema.safeParse({ id: "bad", status: "maybe" }).success).toBe(false);
  });

  it("creates approvals, persists them, mirrors mission.yaml, and records decisions", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "Prepare launch checklist" });
    const approvalStore = createApprovalStore(cwd);
    const approval = await approvalStore.createApproval({
      missionId: mission.id,
      toolName: "report.write",
      toolInput: { path: "report.md", content: "report" },
      riskLevel: "medium",
      sideEffect: "local_write",
      reason: "Tool metadata requires approval."
    });
    const freshStore = createApprovalStore(cwd);
    const approvals = await freshStore.listMissionApprovals(mission.id);
    const mirroredMission = await missionStore.readMission(mission.id);

    expect(approval.id).toMatch(/^a_/);
    expect(approvals).toHaveLength(1);
    expect(mirroredMission.approvals).toEqual(approvals);

    const decided = await freshStore.decideApproval(approval.id, "approved");
    const ledger = await missionStore.readMissionLedger(mission.id);

    expect(decided.status).toBe("approved");
    expect(ledger.at(-1)?.type).toBe("tool.approved");
    await expect(freshStore.decideApproval(approval.id, "denied")).rejects.toThrow("already approved");
  });
});

describe("tool policy classifier", () => {
  it("allows low-risk reads in ask mode and requires approval for medium risk", () => {
    expect(classifyToolPolicy(tool(), DEFAULT_POLICY).action).toBe("allow");
    expect(classifyToolPolicy(tool({ riskLevel: "medium", sideEffect: "local_write" }), DEFAULT_POLICY).action).toBe(
      "approval"
    );
  });

  it("blocks unsafe tools in safe mode and critical tools by default", () => {
    const safePolicy = {
      ...DEFAULT_POLICY,
      mode: "safe" as const
    };

    expect(classifyToolPolicy(tool({ riskLevel: "medium", sideEffect: "local_write" }), safePolicy).action).toBe(
      "block"
    );
    expect(classifyToolPolicy(tool({ riskLevel: "critical", sideEffect: "credential" }), DEFAULT_POLICY).action).toBe(
      "block"
    );
  });

  it("allows medium tools in trusted mode unless tool metadata requires approval", () => {
    const trustedPolicy = {
      ...DEFAULT_POLICY,
      mode: "trusted" as const
    };

    expect(classifyToolPolicy(tool({ riskLevel: "medium", sideEffect: "local_write" }), trustedPolicy).action).toBe(
      "allow"
    );
    expect(
      classifyToolPolicy(tool({ riskLevel: "medium", sideEffect: "local_write", requiresApproval: true }), trustedPolicy)
        .action
    ).toBe("approval");
  });

  it("supports policy file mode changes through the default policy shape", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const policyPath = path.join(cwd, ".narthynx", "policy.yaml");

    await writeFile(policyPath, defaultPolicyYaml().replace("mode: ask", "mode: approval"), "utf8");
    await expect(readFile(policyPath, "utf8")).resolves.toContain("mode: approval");
    expect(createToolRegistry().has("report.write")).toBe(true);
  });
});
