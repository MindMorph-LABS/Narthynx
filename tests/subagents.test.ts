import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createModelRouter } from "../src/agent/model-router";
import type { ModelCallRequest, ModelProvider } from "../src/agent/model-provider";
import { initWorkspace, resolveWorkspacePaths } from "../src/config/workspace";
import { createApprovalStore } from "../src/missions/approvals";
import { createMissionStore, missionDirectory } from "../src/missions/store";
import { ledgerFilePath, readLedgerEvents } from "../src/missions/ledger";
import { SubagentBudget } from "../src/subagents/budget";
import { classifyToolAgainstProfile } from "../src/subagents/tool-gate";
import { runSubagentSession, runSubagentToolGated } from "../src/subagents/orchestrator";
import { loadSubagentsConfig } from "../src/config/subagents-config";
import { subagentProfileSchema } from "../src/subagents/schema";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-subagents-"));
}

async function initializedMission() {
  const cwd = await tempWorkspaceRoot();
  await initWorkspace(cwd);
  const store = createMissionStore(cwd);
  const mission = await store.createMission({ goal: "Subagent test mission" });
  return { cwd, store, mission };
}

function fakeSafetyProvider(blocked: boolean): ModelProvider {
  return {
    name: "fake-safety",
    model: "fake-safety",
    isNetworked: false,
    async call(request: ModelCallRequest) {
      const started = Date.now();
      return {
        provider: "fake-safety",
        model: "fake-safety",
        content: JSON.stringify({
          blocked,
          severity: blocked ? "high" : "low",
          reasons: blocked ? ["synthetic block"] : ["ok"],
          heuristicNote: "test"
        }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        cost: { estimatedCost: 0, currency: "USD" },
        latencyMs: Date.now() - started
      };
    }
  };
}

describe("subagent budget", () => {
  it("rejects a second turn when maxTurns is 1", () => {
    const profile = subagentProfileSchema.parse({
      kind: "verifier",
      maxTurns: 1,
      maxToolCallsPerSession: 2,
      maxModelCallsPerSession: 2
    });
    const budget = new SubagentBudget(profile);
    expect(budget.consumeTurn()).toBe(true);
    expect(budget.consumeTurn()).toBe(false);
  });

  it("blocks tool calls when maxToolCallsPerSession is 0", () => {
    const profile = subagentProfileSchema.parse({
      kind: "verifier",
      maxTurns: 2,
      maxToolCallsPerSession: 0,
      maxModelCallsPerSession: 1
    });
    const budget = new SubagentBudget(profile);
    expect(budget.canUseTool()).toBe(false);
    expect(budget.consumeToolCall()).toBe(false);
  });
});

describe("subagent tool gate", () => {
  it("blocks forbidden tools before execution semantics", () => {
    const profile = subagentProfileSchema.parse({
      kind: "verifier",
      forbiddenTools: ["shell.run"]
    });
    const d = classifyToolAgainstProfile("shell.run", profile);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.code).toBe("forbidden");
    }
  });
});

describe("subagent orchestration", () => {
  it("returns budget error for tool calls when tool cap is zero (no runner)", async () => {
    const { cwd, mission } = await initializedMission();
    const cfgPath = path.join(cwd, ".narthynx", "subagents.yaml");
    await writeFile(
      cfgPath,
      `version: 1
enabled: true
profiles:
  tool_cap_zero:
    kind: verifier
    maxTurns: 2
    maxToolCallsPerSession: 0
    maxModelCallsPerSession: 0
    allowedTools: ["filesystem.list"]
    forbiddenTools: []
`,
      "utf8"
    );

    const cfg = await loadSubagentsConfig(cfgPath);
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) {
      return;
    }
    const profile = cfg.value.profiles["tool_cap_zero"];
    const budget = new SubagentBudget(profile);
    const paths = resolveWorkspacePaths(cwd);
    const ledgerPath = ledgerFilePath(missionDirectory(paths.missionsDir, mission.id));

    const res = await runSubagentToolGated({
      cwd,
      missionId: mission.id,
      profileId: "tool_cap_zero",
      toolName: "filesystem.list",
      toolInput: { path: "." },
      budget,
      profile,
      ledgerPath
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("budget");
    }
  });

  it("records subagent.tool_blocked when tool is forbidden", async () => {
    const { cwd, mission } = await initializedMission();
    const cfgPath = path.join(cwd, ".narthynx", "subagents.yaml");
    await writeFile(
      cfgPath,
      `version: 1
enabled: true
profiles:
  no_shell:
    kind: verifier
    maxTurns: 2
    maxToolCallsPerSession: 2
    maxModelCallsPerSession: 0
    allowedTools: []
    forbiddenTools: ["shell.run"]
`,
      "utf8"
    );

    const cfg = await loadSubagentsConfig(cfgPath);
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) {
      return;
    }
    const profile = cfg.value.profiles["no_shell"];
    const budget = new SubagentBudget(profile);
    const paths = resolveWorkspacePaths(cwd);
    const ledgerPath = ledgerFilePath(missionDirectory(paths.missionsDir, mission.id));

    const res = await runSubagentToolGated({
      cwd,
      missionId: mission.id,
      profileId: "no_shell",
      toolName: "shell.run",
      toolInput: { command: "echo", args: ["hi"] },
      budget,
      profile,
      ledgerPath
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("gate");
    }

    const events = await readLedgerEvents(ledgerPath);
    expect(events.some((e) => e.type === "subagent.tool_blocked")).toBe(true);
  });

  it("verifier flags missing report via deterministic checks", async () => {
    const { cwd, mission } = await initializedMission();
    const approvalStore = createApprovalStore(cwd);
    const router = createModelRouter({ cwd, approvalStore });

    const result = await runSubagentSession({
      cwd,
      missionId: mission.id,
      profileId: "verifier",
      router,
      approvalStoreProvided: approvalStore
    });

    expect(result.status).toBe("completed");
    const payload = result.payload as { ok?: boolean; checks?: Array<{ id: string; ok: boolean }> };
    expect(payload?.ok).toBe(false);
    const reportCheck = payload?.checks?.find((c) => c.id === "report_artifact_present");
    expect(reportCheck?.ok).toBe(false);
  });

  it("safety subagent respects injected model block flag", async () => {
    const { cwd, mission } = await initializedMission();
    const approvalStore = createApprovalStore(cwd);
    const router = createModelRouter({
      cwd,
      approvalStore,
      provider: fakeSafetyProvider(true)
    });

    const result = await runSubagentSession({
      cwd,
      missionId: mission.id,
      profileId: "safety",
      router,
      approvalStoreProvided: approvalStore,
      hypotheticalTool: { toolName: "filesystem.write", toolInput: { path: "x.txt", content: "y" } }
    });

    expect(result.status).toBe("completed");
    const payload = result.payload as { blocked?: boolean };
    expect(payload?.blocked).toBe(true);
  });

  it("verifier session writes ordered subagent ledger events", async () => {
    const { cwd, mission } = await initializedMission();
    const approvalStore = createApprovalStore(cwd);
    const router = createModelRouter({ cwd, approvalStore });

    await runSubagentSession({
      cwd,
      missionId: mission.id,
      profileId: "verifier",
      router,
      approvalStoreProvided: approvalStore
    });

    const paths = resolveWorkspacePaths(cwd);
    const ledgerPath = ledgerFilePath(missionDirectory(paths.missionsDir, mission.id));
    const events = await readLedgerEvents(ledgerPath);
    const types = events.map((e) => e.type);
    const iStart = types.indexOf("subagent.session_started");
    const iDone = types.indexOf("subagent.completed");
    expect(iStart).toBeGreaterThanOrEqual(0);
    expect(iDone).toBeGreaterThan(iStart);
  });

  it("critic with hypothetical tool fails when maxTurns cannot cover two phases", async () => {
    const { cwd, mission } = await initializedMission();
    const cfgPath = path.join(cwd, ".narthynx", "subagents.yaml");
    await writeFile(
      cfgPath,
      `version: 1
enabled: true
profiles:
  critic_tight:
    kind: critic
    maxTurns: 1
    maxToolCallsPerSession: 0
    maxModelCallsPerSession: 2
    allowedTools: []
    forbiddenTools: ["shell.run"]
`,
      "utf8"
    );

    const approvalStore = createApprovalStore(cwd);

    const routerStub = createModelRouter({
      cwd,
      approvalStore,
      provider: {
        name: "noop",
        model: "noop",
        isNetworked: false,
        async call(request) {
          const started = Date.now();
          return {
            provider: "noop",
            model: "noop",
            content: JSON.stringify({ blocked: false, severity: "low", reasons: ["noop"], heuristicNote: "t" }),
            usage: { totalTokens: 1 },
            cost: { estimatedCost: 0, currency: "USD" },
            latencyMs: Date.now() - started
          };
        }
      }
    });

    const result = await runSubagentSession({
      cwd,
      missionId: mission.id,
      profileId: "critic_tight",
      router: routerStub,
      approvalStoreProvided: approvalStore,
      hypotheticalTool: { toolName: "filesystem.read", toolInput: { path: "README.md" } }
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("maxTurns exhausted before safety critique phase");
  });
});
