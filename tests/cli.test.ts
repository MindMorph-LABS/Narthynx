import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CLI_COMMANDS, runCli } from "../src/cli/index";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-cli-"));
}

describe("Narthynx CLI", () => {
  it("prints help with product identity and required command names", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Narthynx");
    expect(result.stdout).toContain("local-first Mission Agent OS");

    for (const command of CLI_COMMANDS) {
      expect(result.stdout).toContain(command);
    }
  });

  it("prints a version matching package.json", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const result = await runCli(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it("initializes a workspace from the CLI", async () => {
    const cwd = await tempWorkspaceRoot();
    const result = await runCli(["init"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workspace is ready");
    await expect(readFile(path.join(cwd, ".narthynx", "config.yaml"), "utf8")).resolves.toContain(
      "workspace_version"
    );
  });

  it("reports an unhealthy workspace before init", async () => {
    const cwd = await tempWorkspaceRoot();
    const result = await runCli(["doctor"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("fail");
    expect(result.stderr).toContain("Run: narthynx init");
  });

  it("reports a healthy workspace after init", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const result = await runCli(["doctor"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workspace is healthy");
  });

  it("creates a mission from the CLI", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const result = await runCli(["mission", "Prepare launch checklist"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Mission created");
    expect(result.stdout).toContain("id: m_");
    expect(result.stdout).toContain("state: created");
    const id = result.stdout.match(/id: (m_[^\s]+)/)?.[1];
    expect(id).toBeDefined();
    await expect(readFile(path.join(cwd, ".narthynx", "missions", id ?? "", "ledger.jsonl"), "utf8")).resolves.toContain(
      "mission.created"
    );
  });

  it("lists missions across separate CLI calls", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    await runCli(["mission", "Prepare launch checklist"], { cwd });
    const result = await runCli(["missions"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Missions");
    expect(result.stdout).toContain("Prepare launch checklist");
    expect(result.stdout).toContain("created");
  });

  it("opens a persisted mission summary", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const result = await runCli(["open", id ?? ""], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Mission ${id}`);
    expect(result.stdout).toContain("goal: Prepare launch checklist");
    expect(result.stdout).toContain("success criteria:");
    expect(result.stdout).toContain(`plan: narthynx plan ${id}`);
    expect(result.stdout).toContain(`timeline: narthynx timeline ${id}`);
  });

  it("prints a mission plan", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const result = await runCli(["plan", id ?? ""], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Plan for ${id}`);
    expect(result.stdout).toContain("1. [research] Understand goal - pending");
    expect(result.stdout).toContain("6. [artifact] Generate final report - pending");
  });

  it("fails clearly for a missing mission plan", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const result = await runCli(["plan", "m_missing"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to read mission at");
  });

  it("prints a mission timeline", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const result = await runCli(["timeline", id ?? ""], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Timeline for ${id}`);
    expect(result.stdout).toContain("1.");
    expect(result.stdout).toContain("mission.created");
  });

  it("fails clearly for a missing mission timeline", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const result = await runCli(["timeline", "m_missing"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to read mission at");
  });

  it("requires a mission goal", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const result = await runCli(["mission"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Mission goal is required");
  });

  it("guides users to initialize the workspace before creating missions", async () => {
    const cwd = await tempWorkspaceRoot();
    const result = await runCli(["mission", "Prepare launch checklist"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Workspace is not initialized. Run: narthynx init");
  });

  it("fails honestly for later-phase placeholders", async () => {
    const result = await runCli(["replay", "m_missing"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not implemented in Phase 4");
  });
});
