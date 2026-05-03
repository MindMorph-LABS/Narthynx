import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IDENTITY_FILE_NAME, loadWorkspaceIdentityFile, resolveWorkspaceActor } from "../src/config/identity-config";
import { initWorkspace, resolveWorkspacePaths } from "../src/config/workspace";
import { createLedgerEvent } from "../src/missions/ledger";
import { createApprovalStore } from "../src/missions/approvals";
import { createMissionStore } from "../src/missions/store";
import { renderReplayEvent } from "../src/missions/replay";

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-id-"));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workspace identity", () => {
  it("loads valid identity.yaml", async () => {
    const dir = await tmp();
    const p = path.join(dir, IDENTITY_FILE_NAME);
    await writeFile(
      p,
      `version: 1
actor_id: alice-dev
display_name: Alice
`,
      "utf8"
    );
    const r = await loadWorkspaceIdentityFile(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.actor_id).toBe("alice-dev");
      expect(r.value.display_name).toBe("Alice");
    }
  });

  it("resolveWorkspaceActor uses env when file missing", async () => {
    const dir = await tmp();
    const paths = resolveWorkspacePaths(dir);
    vi.stubEnv("NARTHYNX_ACTOR_ID", "env-op");
    vi.stubEnv("NARTHYNX_ACTOR_DISPLAY_NAME", "Env Op");
    const a = await resolveWorkspaceActor(paths.identityFile);
    expect(a).toEqual({ id: "env-op", displayName: "Env Op" });
  });

  it("file wins over env when present", async () => {
    const dir = await tmp();
    const paths = resolveWorkspacePaths(dir);
    await mkdir(paths.workspaceDir, { recursive: true });
    await writeFile(paths.identityFile, "version: 1\nactor_id: from-file\n", "utf8");
    vi.stubEnv("NARTHYNX_ACTOR_ID", "ignored");
    const a = await resolveWorkspaceActor(paths.identityFile);
    expect(a?.id).toBe("from-file");
  });
});

describe("ledger actor merge", () => {
  it("merges actor into details", () => {
    const ev = createLedgerEvent({
      missionId: "m_x",
      type: "tool.approved",
      summary: "ok",
      details: { toolName: "x" },
      actor: { id: "u1", displayName: "Pat" }
    });
    expect(ev.details?.actor).toEqual({ id: "u1", displayName: "Pat" });
    expect((ev.details as Record<string, unknown>).toolName).toBe("x");
  });
});

describe("approval ledger attribution", () => {
  it("records actor on decideApproval when provided", async () => {
    const cwd = await tmp();
    await initWorkspace(cwd);
    await writeFile(
      path.join(cwd, ".narthynx", IDENTITY_FILE_NAME),
      "version: 1\nactor_id: bob\n",
      "utf8"
    );
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "g" });
    const approvals = createApprovalStore(cwd);
    const paths = resolveWorkspacePaths(cwd);
    const actor = await resolveWorkspaceActor(paths.identityFile);
    const a = await approvals.createApproval({
      missionId: mission.id,
      toolName: "report.write",
      toolInput: { path: "r.md" },
      riskLevel: "medium",
      sideEffect: "local_write",
      reason: "test"
    });
    await approvals.decideApproval(a.id, "approved", "ok", { actor });
    const ledger = await store.readMissionLedger(mission.id);
    const last = ledger.filter((e) => e.type === "tool.approved").at(-1);
    expect((last?.details as Record<string, unknown>)?.actor).toEqual({ id: "bob" });
  });
});

describe("replay actor suffix", () => {
  it("appends actor to tool.approved", () => {
    const text = renderReplayEvent({
      id: "e_1",
      missionId: "m_1",
      type: "tool.approved",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "x",
      details: {
        toolName: "shell.run",
        approvalId: "a_1",
        actor: { id: "chef", displayName: "Chef" }
      }
    });
    expect(text).toContain("by Chef (chef)");
  });
});
