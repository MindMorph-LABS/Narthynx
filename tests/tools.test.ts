import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { initWorkspace } from "../src/config/workspace";
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
      "filesystem.list",
      "filesystem.read",
      "git.status",
      "report.write"
    ]);
    expect(tools.map((tool) => `${tool.name}:${tool.sideEffect}:${tool.riskLevel}:${tool.requiresApproval}`)).toContain(
      "report.write:local_write:medium:true"
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

  it("blocks approval-required tools without writing files or approval events", async () => {
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
      expect(result.message).toContain("Phase 6");
    }
    await expect(readFile(path.join(cwd, "report.md"), "utf8")).rejects.toThrow();
    expect(ledger.map((event) => event.type)).not.toContain("tool.approved");
    expect(ledger.at(-1)?.type).toBe("tool.failed");
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
