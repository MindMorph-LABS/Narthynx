import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { initWorkspace } from "../src/config/workspace";
import { createCockpitApp } from "../src/cockpit/app";
import { createApprovalStore } from "../src/missions/approvals";
import { createMissionStore } from "../src/missions/store";

const TOKEN = "test-cockpit-token";

async function cockpitAppForWorkspace(cwd: string) {
  const staticRoot = path.join(cwd, "spa");
  await mkdir(staticRoot, { recursive: true });
  await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><html><body></body></html>", "utf8");
  return createCockpitApp({ cwd, staticRoot, bearerToken: TOKEN, allowLan: false });
}

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-cockpit-"));
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TOKEN}` };
}

describe("Mission Cockpit HTTP API", () => {
  it("returns 401 for /api routes without Authorization", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const app = await cockpitAppForWorkspace(cwd);
    const res = await app.request("http://localhost/api/missions");
    expect(res.status).toBe(401);
  });

  it("lists missions and mirrors CLI approval + ledger semantics on approve", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "Cockpit parity test mission" });
    const approvalStore = createApprovalStore(cwd);
    const approval = await approvalStore.createApproval({
      missionId: mission.id,
      toolName: "report.write",
      toolInput: { path: "report.md", content: "cockpit" },
      riskLevel: "medium",
      sideEffect: "local_write",
      reason: "Test approval for cockpit."
    });

    const app = await cockpitAppForWorkspace(cwd);

    const pending = await app.request("http://localhost/api/approvals/pending", { headers: authHeaders() });
    expect(pending.status).toBe(200);
    const pendingJson = (await pending.json()) as { approvals: Array<{ id: string }> };
    expect(pendingJson.approvals.some((a) => a.id === approval.id)).toBe(true);

    const list = await app.request("http://localhost/api/missions", { headers: authHeaders() });
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as { missions: Array<{ id: string }> };
    expect(listJson.missions.some((m) => m.id === mission.id)).toBe(true);

    const decide = await app.request(`http://localhost/api/approvals/${approval.id}/decide`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved", reason: "ok" })
    });
    expect(decide.status).toBe(200);
    const decideJson = (await decide.json()) as { approval: { status: string } };
    expect(decideJson.approval.status).toBe("approved");

    const ledger = await missionStore.readMissionLedger(mission.id);
    expect(ledger.some((ev) => ev.type === "tool.approved")).toBe(true);

    const pendingAfter = await app.request("http://localhost/api/approvals/pending", { headers: authHeaders() });
    const pendingAfterJson = (await pendingAfter.json()) as { approvals: Array<{ id: string }> };
    expect(pendingAfterJson.approvals.every((a) => a.id !== approval.id)).toBe(true);
  });

  it("records tool.denied on deny via API (CLI parity)", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "Deny path" });
    const approvalStore = createApprovalStore(cwd);
    const approval = await approvalStore.createApproval({
      missionId: mission.id,
      toolName: "report.write",
      toolInput: { path: "report.md", content: "x" },
      riskLevel: "medium",
      sideEffect: "local_write",
      reason: "Deny test."
    });

    const app = await cockpitAppForWorkspace(cwd);
    const decide = await app.request(`http://localhost/api/approvals/${approval.id}/decide`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "denied", reason: "no" })
    });
    expect(decide.status).toBe(200);
    const ledger = await missionStore.readMissionLedger(mission.id);
    expect(ledger.some((ev) => ev.type === "tool.denied")).toBe(true);
  });
});
