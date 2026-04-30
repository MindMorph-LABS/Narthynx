import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/index";
import { INTERACTIVE_INTERRUPT, runInteractiveSession } from "../src/cli/interactive";
import { parseSlashCommand } from "../src/cli/slash-commands";
import { initWorkspace } from "../src/config/workspace";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-interactive-"));
}

describe("slash command parser", () => {
  it("parses quoted mission goals", () => {
    expect(parseSlashCommand('/mission "Prepare launch checklist"')).toEqual({
      raw: '/mission "Prepare launch checklist"',
      name: "mission",
      args: ["Prepare launch checklist"]
    });
  });

  it("parses aliases and flags without lowercasing arguments", () => {
    expect(parseSlashCommand('/approve a_123 --deny --reason "Not now"')).toEqual({
      raw: '/approve a_123 --deny --reason "Not now"',
      name: "approve",
      args: ["a_123", "--deny", "--reason", "Not now"]
    });
  });

  it("rejects unclosed quotes and missing command names", () => {
    expect(() => parseSlashCommand('/mission "unfinished')).toThrow("Unclosed");
    expect(() => parseSlashCommand("/")).toThrow("Slash command is required");
  });
});

describe("interactive session", () => {
  it("renders help and exits cleanly through injected CLI input", async () => {
    const result = await runCli([], {
      interactiveInput: ["/help", "/exit"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Narthynx interactive");
    expect(result.stdout).toContain("Narthynx slash commands");
    expect(result.stdout).toContain("Exiting Narthynx interactive.");
  });

  it("reports unhealthy and healthy workspace status", async () => {
    const cwd = await tempWorkspaceRoot();
    const unhealthy = await runInteractiveSession({
      cwd,
      inputLines: ["/doctor", "/exit"]
    });
    await initWorkspace(cwd);
    const healthy = await runInteractiveSession({
      cwd,
      inputLines: ["/doctor", "/exit"]
    });

    expect(unhealthy.stdout).toContain("Workspace is not healthy. Run: narthynx init");
    expect(healthy.stdout).toContain("Workspace is healthy.");
  });

  it("creates a mission, keeps it selected, and infers it for plan, timeline, report, and replay", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const result = await runInteractiveSession({
      cwd,
      inputLines: ['/mission "Prepare launch checklist"', "/plan", "/timeline", "/report", "/replay", "/exit"]
    });
    const missionId = result.stdout.match(/Mission (m_[^\s]+)/)?.[1];

    expect(result.exitCode).toBe(0);
    expect(missionId).toBeDefined();
    expect(result.currentMissionId).toBe(missionId);
    expect(result.stdout).toContain("Mission created and selected");
    expect(result.stdout).toContain(`Plan for ${missionId}`);
    expect(result.stdout).toContain(`Timeline for ${missionId}`);
    expect(result.stdout).toContain("Report created");
    expect(result.stdout).toContain(`Replay for ${missionId}: Prepare launch checklist`);
  });

  it("creates and approves a filesystem.write approval inside interactive mode", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const first = await runInteractiveSession({
      cwd,
      inputLines: [
        '/mission "Prepare launch checklist"',
        '/tool filesystem.write --input \'{"path":"launch.md","content":"ready\\n"}\'',
        "/approve",
        "/exit"
      ]
    });
    const approvalId = first.stdout.match(/approve (a_[^\s]+)/)?.[1];

    expect(approvalId).toBeDefined();

    const approved = await runInteractiveSession({
      cwd,
      inputLines: [`/approve ${approvalId}`, "/exit"]
    });

    expect(approved.exitCode).toBe(0);
    expect(approved.stdout).toContain(`Approval approved: ${approvalId}`);
    expect(approved.stdout).toContain("Approved action executed.");
    expect(approved.stdout).toContain("checkpoint: c_");
    await expect(readFile(path.join(cwd, "launch.md"), "utf8")).resolves.toBe("ready\n");
  });

  it("does not execute future shell, context, or memory shortcuts", async () => {
    const result = await runInteractiveSession({
      inputLines: ["! echo hi", "@ README.md", "# remember this", "/exit"]
    });

    expect(result.stdout).toContain("Shell execution is reserved for Phase 11 and was not run.");
    expect(result.stdout).toContain("Context attachment shortcuts are reserved for a future context workflow");
    expect(result.stdout).toContain("Mission memory shortcuts are reserved for a future memory workflow");
  });

  it("handles interrupt without mutating state", async () => {
    const result = await runInteractiveSession({
      inputLines: [INTERACTIVE_INTERRUPT]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Interrupted. Mission state is persisted");
  });

  it("reports missing current mission clearly", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const result = await runInteractiveSession({
      cwd,
      inputLines: ["/plan", "/exit"]
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No current mission. Run /mission <goal> or /mission <mission-id>.");
  });

  it("reports unknown slash commands clearly", async () => {
    const result = await runInteractiveSession({
      inputLines: ["/unknown", "/exit"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Unknown slash command: /unknown");
  });
});
