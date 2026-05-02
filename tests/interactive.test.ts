import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    expect(result.stdout).toContain("NARTHYNX");
    expect(result.stdout).toContain("Narthynx slash commands (full reference:");
    expect(result.stdout).toContain("Missions & planning");
    expect(result.stdout).toContain("/mode [plan|ask]");
    expect(result.stdout).toContain("/cost [mission-id]");
    expect(result.stdout).toContain("/graph [mission-id]");
    expect(result.stdout).toContain("/report /proof /replay [id]");
    expect(result.stdout).toContain("Exiting Narthynx interactive.");
    expect(result.stdout).toContain("Mission state saved.");
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
      inputLines: ['/mission "Prepare launch checklist"', "/plan", "/timeline", "/report", "/replay", "/cost", "/exit"]
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
    expect(result.stdout).toContain(`Cost for ${missionId}`);
    expect(result.stdout).toContain("model calls: 0");
  });

  it("uses templates, context shortcuts, and proof cards with current mission inference", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    await writeFile(path.join(cwd, "notes.md"), "safe context\n", "utf8");

    const result = await runInteractiveSession({
      cwd,
      inputLines: ["/templates", "/mission --template bug-investigation", "# remember the failing CLI path", "@ notes.md", "/context", "/proof", "/exit"]
    });
    const missionId = result.stdout.match(/Mission (m_[^\s]+)/)?.[1];

    expect(result.exitCode).toBe(0);
    expect(missionId).toBeDefined();
    expect(result.stdout).toContain("bug-investigation");
    expect(result.stdout).toContain("Context note added");
    expect(result.stdout).toContain("Context file attached");
    expect(result.stdout).toContain("estimated tokens:");
    expect(result.stdout).toContain("Proof card created");
  });

  it("supports model planning and cost summaries with current mission inference", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const result = await runInteractiveSession({
      cwd,
      inputLines: ['/mission "Prepare launch checklist"', "/plan --model", "/cost", "/exit"]
    });
    const missionId = result.stdout.match(/Mission (m_[^\s]+)/)?.[1];

    expect(result.exitCode).toBe(0);
    expect(missionId).toBeDefined();
    expect(result.stdout).toContain(`Plan for ${missionId} (model)`);
    expect(result.stdout).toContain("model calls: 1");
  });

  it("runs, approves, resumes, reports, and replays the Phase 13 executor flow", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const first = await runInteractiveSession({
      cwd,
      inputLines: ['/mission "Prepare launch checklist"', "/run", "/exit"]
    });
    const missionId = first.stdout.match(/Mission (m_[^\s]+)/)?.[1];
    const approvalId = first.stdout.match(/Paused for approval: (a_[^\s]+)/)?.[1];

    expect(missionId).toBeDefined();
    expect(approvalId).toBeDefined();
    expect(first.stdout).toContain("Completed node: Gather relevant context (git.status)");

    const second = await runInteractiveSession({
      cwd,
      inputLines: [`/approve ${approvalId}`, `/resume ${missionId}`, "/report", "/replay", "/exit"]
    });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain(`Approval approved: ${approvalId}`);
    expect(second.stdout).toContain(`Mission completed: ${missionId}`);
    expect(second.stdout).toContain("Report regenerated");
    expect(second.stdout).toContain("Node completed: Generate final report");
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

  it("routes shell shortcuts to shell.run approvals without executing immediately", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const result = await runInteractiveSession({
      cwd,
      inputLines: ['/mission "Prepare launch checklist"', "! node --version", "/exit"]
    });

    expect(result.stdout).toContain("Approval required");
    expect(result.stdout).toContain("shell.run");
    expect(result.stdout).toMatch(/\/approve a_[a-z0-9_-]+/);
  });

  it("reports context shortcuts clearly when no current mission is selected", async () => {
    const result = await runInteractiveSession({
      inputLines: ["@ README.md", "# remember this", "/exit"]
    });

    expect(result.stderr).toContain("No current mission. Run /mission <goal> or /mission <mission-id>.");
  });

  it("executes approved shell.run from interactive approval", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const first = await runInteractiveSession({
      cwd,
      inputLines: [
        '/mission "Prepare launch checklist"',
        `/tool shell.run --input '${JSON.stringify({ command: process.execPath, args: ["--version"] })}'`,
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
    expect(approved.stdout).toContain("artifacts/outputs/shell-run");
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
    expect(result.stderr).toContain("Unknown slash command: /unknown");
    expect(result.stderr).toContain("Try /help");
    expect(result.stderr).toContain("Common:");
  });
});
