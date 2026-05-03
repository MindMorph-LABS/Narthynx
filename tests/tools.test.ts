import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defaultPolicyYaml } from "../src/config/defaults";
import { initWorkspace } from "../src/config/workspace";
import { createApprovalStore } from "../src/missions/approvals";
import { createMissionStore } from "../src/missions/store";
import { createToolRegistry } from "../src/tools/registry";
import { createToolRunner } from "../src/tools/runner";
import type { ToolAction } from "../src/tools/types";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-tools-"));
}

async function initializedMission() {
  const cwd = await tempWorkspaceRoot();
  await initWorkspace(cwd);
  const store = createMissionStore(cwd);
  const mission = await store.createMission({ goal: "Prepare launch checklist" });

  return {
    cwd,
    store,
    mission
  };
}

describe("tool registry", () => {
  it("lists MVP tools with risk metadata", () => {
    const registry = createToolRegistry();
    const tools = registry.list();

    expect(tools.map((tool) => tool.name)).toEqual([
      "browser.click",
      "browser.fill",
      "browser.navigate",
      "browser.press",
      "browser.screenshot",
      "browser.snapshot",
      "filesystem.list",
      "filesystem.read",
      "filesystem.write",
      "git.diff",
      "git.log",
      "git.status",
      "github.issues.create",
      "github.issues.createComment",
      "github.issues.get",
      "github.issues.list",
      "github.issues.listComments",
      "github.pulls.get",
      "github.pulls.list",
      "github.pulls.listFiles",
      "github.repos.get",
      "mcp.servers.list",
      "mcp.tools.call",
      "mcp.tools.list",
      "report.write",
      "shell.run",
      "vault.read"
    ]);
    expect(tools.map((tool) => `${tool.name}:${tool.sideEffect}:${tool.riskLevel}:${tool.requiresApproval}`)).toContain(
      "report.write:local_write:medium:true"
    );
    expect(tools.map((tool) => `${tool.name}:${tool.sideEffect}:${tool.riskLevel}:${tool.requiresApproval}`)).toContain(
      "filesystem.write:local_write:high:true"
    );
    expect(tools.map((tool) => `${tool.name}:${tool.sideEffect}:${tool.riskLevel}:${tool.requiresApproval}`)).toContain(
      "browser.navigate:network:high:true"
    );
    expect(tools.map((tool) => `${tool.name}:${tool.sideEffect}:${tool.riskLevel}:${tool.requiresApproval}`)).toContain(
      "shell.run:shell:high:true"
    );
    expect(tools.map((tool) => `${tool.name}:${tool.sideEffect}:${tool.riskLevel}:${tool.requiresApproval}`)).toContain(
      "mcp.tools.call:external_comm:high:true"
    );
    expect(tools.map((tool) => `${tool.name}:${tool.sideEffect}:${tool.riskLevel}:${tool.requiresApproval}`)).toContain(
      "github.repos.get:external_comm:low:false"
    );
    expect(tools.map((tool) => `${tool.name}:${tool.sideEffect}:${tool.riskLevel}:${tool.requiresApproval}`)).toContain(
      "github.issues.create:external_comm:high:true"
    );
  });

  it("rejects unknown tools", () => {
    const registry = createToolRegistry();

    expect(() => registry.get("unknown.tool")).toThrow("Unknown tool: unknown.tool");
  });
});

describe("tool runner", () => {
  it("runs filesystem.list and records requested, started, and completed events", async () => {
    const { cwd, store, mission } = await initializedMission();
    await writeFile(path.join(cwd, "README.local.md"), "hello\n", "utf8");
    const runner = createToolRunner({ cwd });
    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "filesystem.list",
      input: { path: "." }
    });
    const ledger = await store.readMissionLedger(mission.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.output)).toContain("README.local.md");
    }
    expect(ledger.map((event) => event.type).slice(-3)).toEqual(["tool.requested", "tool.started", "tool.completed"]);
  }, 15_000);

  it("reads safe files and blocks secret-like files", async () => {
    const { cwd, store, mission } = await initializedMission();
    await writeFile(path.join(cwd, "notes.md"), "safe context\n", "utf8");
    await writeFile(path.join(cwd, ".env"), "TOKEN=secret\n", "utf8");
    const runner = createToolRunner({ cwd });

    const safe = await runner.runTool({
      missionId: mission.id,
      toolName: "filesystem.read",
      input: { path: "notes.md" }
    });
    const blocked = await runner.runTool({
      missionId: mission.id,
      toolName: "filesystem.read",
      input: { path: ".env" }
    });
    const ledger = await store.readMissionLedger(mission.id);

    expect(safe.ok).toBe(true);
    if (safe.ok) {
      expect(JSON.stringify(safe.output)).toContain("safe context");
    }
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.message).toContain("blocked by policy");
    }
    expect(ledger.at(-1)?.type).toBe("tool.failed");
  }, 15_000);

  it("blocks paths outside the workspace", async () => {
    const { cwd, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "filesystem.read",
      input: { path: "../outside.txt" }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("outside the workspace");
    }
  }, 15_000);

  it("runs git.status without requiring a shell", async () => {
    const { cwd, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "git.status",
      input: {}
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.output)).toContain("isRepository");
    }
  }, 15_000);

  it("runs git.diff and git.log as read-only tools and handles non-repositories honestly", async () => {
    const { cwd, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const diff = await runner.runTool({
      missionId: mission.id,
      toolName: "git.diff",
      input: {}
    });
    const log = await runner.runTool({
      missionId: mission.id,
      toolName: "git.log",
      input: { maxCount: 3 }
    });

    expect(diff.ok).toBe(true);
    expect(log.ok).toBe(true);
    if (diff.ok) {
      expect(JSON.stringify(diff.output)).toContain("\"isRepository\":false");
    }
    if (log.ok) {
      expect(JSON.stringify(log.output)).toContain("\"isRepository\":false");
    }
  }, 15_000);

  it("creates a pending approval for approval-required tools without writing files", async () => {
    const { cwd, store, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "report.write",
      input: { path: "report.md", content: "report" }
    });
    const ledger = await store.readMissionLedger(mission.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
      expect(result.approvalId).toMatch(/^a_/);
      expect(result.message).toContain("narthynx approve");
    }
    await expect(readFile(path.join(cwd, "report.md"), "utf8")).rejects.toThrow();
    expect(ledger.map((event) => event.type)).not.toContain("tool.started");
    expect(ledger.at(-1)?.type).toBe("tool.denied");
    expect(ledger.at(-1)?.details).toMatchObject({
      status: "pending_approval"
    });
  }, 15_000);

  it("creates a pending approval for filesystem.write and does not write before approval", async () => {
    const { cwd, store, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "filesystem.write",
      input: { path: "launch.md", content: "ready\n" }
    });
    const ledger = await store.readMissionLedger(mission.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.approvalId).toMatch(/^a_/);
    }
    await expect(readFile(path.join(cwd, "launch.md"), "utf8")).rejects.toThrow();
    expect(ledger.at(-1)?.type).toBe("tool.denied");
    expect(ledger.at(-1)?.details).toMatchObject({
      status: "pending_approval"
    });
  }, 15_000);

  it("creates a pending approval for shell.run and does not execute before approval", async () => {
    const { cwd, store, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "shell.run",
      input: { command: process.execPath, args: ["--version"] }
    });
    const ledger = await store.readMissionLedger(mission.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.approvalId).toMatch(/^a_/);
      expect(result.message).toContain("shell.run requires approval");
    }
    expect(ledger.at(-1)?.type).toBe("tool.denied");
    expect(ledger.at(-1)?.details).toMatchObject({
      status: "pending_approval"
    });
  }, 15_000);

  it("executes approved shell.run once and writes an output artifact", async () => {
    const { cwd, store, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const approvalStore = createApprovalStore(cwd);
    const requested = await runner.runTool({
      missionId: mission.id,
      toolName: "shell.run",
      input: { command: process.execPath, args: ["--version"] }
    });
    const approvalId = requested.ok ? undefined : requested.approvalId;

    expect(approvalId).toBeDefined();
    await approvalStore.decideApproval(approvalId ?? "", "approved");
    const executed = await runner.runApprovedTool(approvalId ?? "");
    const repeated = await runner.runApprovedTool(approvalId ?? "");
    const ledger = await store.readMissionLedger(mission.id);

    expect(executed.ok).toBe(true);
    if (executed.ok) {
      const output = executed.output as { stdout?: string; artifactPath?: string };
      expect(output.stdout).toContain("v");
      expect(output.artifactPath).toContain("artifacts/outputs/shell-run");
      await expect(readFile(path.join(cwd, ".narthynx", "missions", mission.id, output.artifactPath ?? ""), "utf8")).resolves.toContain(
        `command: ${process.execPath}`
      );
    }
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) {
      expect(repeated.message).toContain("already been executed");
    }
    expect(ledger.map((event) => event.type)).toContain("artifact.created");
    expect(ledger.map((event) => event.type).slice(-3)).toEqual(["tool.started", "artifact.created", "tool.completed"]);
  }, 15_000);

  it("does not continue denied shell.run approvals", async () => {
    const { cwd, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const approvalStore = createApprovalStore(cwd);
    const requested = await runner.runTool({
      missionId: mission.id,
      toolName: "shell.run",
      input: { command: process.execPath, args: ["--version"] }
    });
    const approvalId = requested.ok ? undefined : requested.approvalId;

    expect(approvalId).toBeDefined();
    await approvalStore.decideApproval(approvalId ?? "", "denied", "not now");
    const result = await runner.runApprovedTool(approvalId ?? "");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("denied");
    }
  }, 15_000);

  it("blocks dangerous shell.run commands without creating approvals", async () => {
    const { cwd, store, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const destructive = await runner.runTool({
      missionId: mission.id,
      toolName: "shell.run",
      input: { command: "rm", args: ["-rf", "."] }
    });
    const metacharacter = await runner.runTool({
      missionId: mission.id,
      toolName: "shell.run",
      input: { command: "echo", args: ["hello", "|", "sh"] }
    });
    const updatedMission = await store.readMission(mission.id);

    expect(destructive.ok).toBe(false);
    expect(metacharacter.ok).toBe(false);
    if (!destructive.ok) {
      expect(destructive.approvalId).toBeUndefined();
      expect(destructive.message).toContain("blocked");
    }
    if (!metacharacter.ok) {
      expect(metacharacter.approvalId).toBeUndefined();
      expect(metacharacter.message).toContain("Shell metacharacters");
    }
    expect(updatedMission.approvals).toEqual([]);
  }, 15_000);

  it("continues approved filesystem.write with a checkpoint and prevents double execution", async () => {
    const { cwd, store, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const approvalStore = createApprovalStore(cwd);
    const requested = await runner.runTool({
      missionId: mission.id,
      toolName: "filesystem.write",
      input: { path: "launch.md", content: "ready\n" }
    });
    const approvalId = requested.ok ? undefined : requested.approvalId;

    expect(approvalId).toBeDefined();
    await approvalStore.decideApproval(approvalId ?? "", "approved");
    const executed = await runner.runApprovedTool(approvalId ?? "");
    const repeated = await runner.runApprovedTool(approvalId ?? "");
    const ledger = await store.readMissionLedger(mission.id);

    expect(executed.ok).toBe(true);
    if (executed.ok) {
      expect(executed.checkpointId).toMatch(/^c_/);
    }
    await expect(readFile(path.join(cwd, "launch.md"), "utf8")).resolves.toBe("ready\n");
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) {
      expect(repeated.message).toContain("already been executed");
    }
    expect(ledger.map((event) => event.type).slice(-4)).toEqual([
      "tool.approved",
      "checkpoint.created",
      "tool.started",
      "tool.completed"
    ]);
  }, 15_000);

  it("does not continue denied filesystem.write approvals", async () => {
    const { cwd, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const approvalStore = createApprovalStore(cwd);
    const requested = await runner.runTool({
      missionId: mission.id,
      toolName: "filesystem.write",
      input: { path: "launch.md", content: "ready\n" }
    });
    const approvalId = requested.ok ? undefined : requested.approvalId;

    expect(approvalId).toBeDefined();
    await approvalStore.decideApproval(approvalId ?? "", "denied", "not now");
    const result = await runner.runApprovedTool(approvalId ?? "");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("denied");
    }
    await expect(readFile(path.join(cwd, "launch.md"), "utf8")).rejects.toThrow();
  }, 15_000);

  it("executes approved report.write only under mission artifacts", async () => {
    const { cwd, mission } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const approvalStore = createApprovalStore(cwd);
    const requested = await runner.runTool({
      missionId: mission.id,
      toolName: "report.write",
      input: { path: "report.md", content: "report" }
    });
    const approvalId = requested.ok ? undefined : requested.approvalId;

    expect(approvalId).toBeDefined();
    await approvalStore.decideApproval(approvalId ?? "", "approved");
    const result = await runner.runApprovedTool(approvalId ?? "");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.output)).toContain("artifacts/report.md");
    }
    await expect(readFile(path.join(cwd, ".narthynx", "missions", mission.id, "artifacts", "report.md"), "utf8")).resolves.toBe(
      "report"
    );
    await expect(readFile(path.join(cwd, "report.md"), "utf8")).rejects.toThrow();
  }, 15_000);

  it("blocks policy-denied tools without creating approvals", async () => {
    const { cwd, store, mission } = await initializedMission();
    await writeFile(path.join(cwd, ".narthynx", "policy.yaml"), defaultPolicyYaml().replace("mode: ask", "mode: safe"), "utf8");
    const runner = createToolRunner({ cwd });
    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "report.write",
      input: { path: "report.md", content: "report" }
    });
    const ledger = await store.readMissionLedger(mission.id);
    const updatedMission = await store.readMission(mission.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Safe mode");
      expect(result.approvalId).toBeUndefined();
    }
    expect(updatedMission.approvals).toEqual([]);
    expect(ledger.at(-1)?.type).toBe("tool.denied");
    expect(ledger.at(-1)?.details).toMatchObject({
      status: "blocked"
    });
  }, 15_000);

  it("blocks shell.run when shell policy is block or mode is safe", async () => {
    const { cwd, store, mission } = await initializedMission();
    const policyPath = path.join(cwd, ".narthynx", "policy.yaml");
    await writeFile(policyPath, defaultPolicyYaml().replace("shell: ask", "shell: block"), "utf8");
    const shellBlocked = await createToolRunner({ cwd }).runTool({
      missionId: mission.id,
      toolName: "shell.run",
      input: { command: process.execPath, args: ["--version"] }
    });
    await writeFile(policyPath, defaultPolicyYaml().replace("mode: ask", "mode: safe"), "utf8");
    const safeBlocked = await createToolRunner({ cwd }).runTool({
      missionId: mission.id,
      toolName: "shell.run",
      input: { command: process.execPath, args: ["--version"] }
    });
    const updatedMission = await store.readMission(mission.id);

    expect(shellBlocked.ok).toBe(false);
    expect(safeBlocked.ok).toBe(false);
    if (!shellBlocked.ok) {
      expect(shellBlocked.message).toContain("Shell tools are blocked by policy");
      expect(shellBlocked.approvalId).toBeUndefined();
    }
    if (!safeBlocked.ok) {
      expect(safeBlocked.message).toContain("Safe mode");
      expect(safeBlocked.approvalId).toBeUndefined();
    }
    expect(updatedMission.approvals).toEqual([]);
  }, 15_000);

  it("records invalid input as a tool failure before execution", async () => {
    const { store, mission, cwd } = await initializedMission();
    const runner = createToolRunner({ cwd });
    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "filesystem.read",
      input: { path: "" }
    });
    const ledger = await store.readMissionLedger(mission.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Invalid input");
    }
    expect(ledger.map((event) => event.type).slice(-2)).toEqual(["tool.requested", "tool.failed"]);
  }, 15_000);

  it("records invalid tool output as a tool failure", async () => {
    const { cwd, store, mission } = await initializedMission();
    const invalidTool: ToolAction<unknown, unknown> = {
      name: "bad.output",
      description: "Returns output that does not match its schema.",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.literal(true) }),
      riskLevel: "low",
      sideEffect: "none",
      requiresApproval: false,
      reversible: true,
      async run() {
        return { ok: false };
      }
    };
    const runner = createToolRunner({
      cwd,
      registry: createToolRegistry([invalidTool])
    });
    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "bad.output",
      input: {}
    });
    const ledger = await store.readMissionLedger(mission.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Invalid output");
    }
    expect(ledger.at(-1)?.type).toBe("tool.failed");
  }, 15_000);

  it("requires an initialized workspace and existing mission", async () => {
    const cwd = await tempWorkspaceRoot();
    const runner = createToolRunner({ cwd });

    await expect(
      runner.runTool({
        missionId: "m_missing",
        toolName: "filesystem.list",
        input: { path: "." }
      })
    ).rejects.toThrow("Workspace is not initialized. Run: narthynx init");

    await initWorkspace(cwd);
    await mkdir(path.join(cwd, ".narthynx", "missions", "m_missing"), { recursive: true });
    await expect(
      runner.runTool({
        missionId: "m_missing",
        toolName: "filesystem.list",
        input: { path: "." }
      })
    ).rejects.toThrow("Failed to read mission at");
  }, 15_000);
});
