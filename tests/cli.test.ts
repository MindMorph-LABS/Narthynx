import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("validates triggers.yaml via triggers doctor", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const noRules = await runCli(["triggers", "doctor"], { cwd });
    expect(noRules.exitCode).toBe(1);
    expect(noRules.stderr + noRules.stdout).toMatch(/triggers\.yaml/i);

    const triggersText = `version: 1
rules:
  - id: t1
    source: github
    match: {}
    action:
      type: create_mission
      goalTemplate: "x"
    dedupKeyFrom:
      - "k"
`;
    await writeFile(path.join(cwd, ".narthynx", "triggers.yaml"), triggersText, "utf8");
    const ok = await runCli(["triggers", "doctor"], { cwd });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("triggers.yaml OK");
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
    expect(result.stdout).toContain(`report: narthynx report ${id}`);
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

  it("lists templates and creates a template mission from the CLI", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const templates = await runCli(["templates"], { cwd });
    const created = await runCli(["mission", "--template", "bug-investigation"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];
    const opened = await runCli(["open", id ?? ""], { cwd });

    expect(templates.exitCode).toBe(0);
    expect(templates.stdout).toContain("bug-investigation");
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("template: bug-investigation");
    expect(opened.stdout).toContain("title: Bug investigation");
  });

  it("regenerates a mission plan through the stub model provider and records cost", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const result = await runCli(["plan", id ?? "", "--model"], { cwd });
    const cost = await runCli(["cost", id ?? ""], { cwd });
    const timeline = await runCli(["timeline", id ?? ""], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Plan for ${id} (model)`);
    expect(cost.exitCode).toBe(0);
    expect(cost.stdout).toContain("model calls: 1");
    expect(cost.stdout).toContain("estimated cost: USD 0.000000");
    expect(timeline.stdout).toContain("model.called");
    expect(timeline.stdout).toContain("cost.recorded");
    expect(timeline.stdout).toContain("plan.updated");
  });

  it("reports zero model cost for a fresh deterministic mission", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const result = await runCli(["cost", id ?? ""], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Cost for ${id}`);
    expect(result.stdout).toContain("model calls: 0");
    expect(result.stdout).toContain("providers: none");
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

  it("replays a newly created mission as a story", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const result = await runCli(["replay", id ?? ""], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Replay for ${id}: Prepare launch checklist`);
    expect(result.stdout).toContain("1. Mission created: Prepare launch checklist");
    expect(result.stdout).toContain("2. Plan created: 6 nodes, 5 edges");
  });

  it("generates a mission report from the CLI", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const result = await runCli(["report", id ?? ""], { cwd });
    const reportPath = path.join(cwd, ".narthynx", "missions", id ?? "", "artifacts", "report.md");
    const timeline = await runCli(["timeline", id ?? ""], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Report created");
    expect(result.stdout).toContain("artifact: art_");
    expect(result.stdout).toContain(reportPath);
    await expect(readFile(reportPath, "utf8")).resolves.toContain("## Goal");
    expect(timeline.stdout).toContain("artifact.created");
  });

  it("fails clearly for a missing mission report", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const result = await runCli(["report", "m_missing"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to read mission at");
  });

  it("lists registered typed tools", async () => {
    const result = await runCli(["tools"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("filesystem.list");
    expect(result.stdout).toContain("filesystem.read");
    expect(result.stdout).toContain("filesystem.write");
    expect(result.stdout).toContain("git.diff");
    expect(result.stdout).toContain("git.log");
    expect(result.stdout).toContain("git.status");
    expect(result.stdout).toContain("report.write");
    expect(result.stdout).toContain("shell.run");
  });

  it("adds context notes and files and generates proof cards from the CLI", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    await writeFile(path.join(cwd, "notes.md"), "safe context\n", "utf8");
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const note = await runCli(["context", id ?? "", "--note", "Focus on release blockers."], { cwd });
    const file = await runCli(["context", id ?? "", "--file", "notes.md", "--reason", "safe notes"], { cwd });
    const summary = await runCli(["context", id ?? ""], { cwd });
    const proof = await runCli(["proof", id ?? ""], { cwd });
    const report = await runCli(["report", id ?? ""], { cwd });
    const proofPath = path.join(cwd, ".narthynx", "missions", id ?? "", "artifacts", "proof-card.md");

    expect(note.exitCode).toBe(0);
    expect(note.stdout).toContain("Context note added");
    expect(file.exitCode).toBe(0);
    expect(file.stdout).toContain("Context file attached");
    expect(summary.stdout).toContain("estimated tokens:");
    expect(summary.stdout).toContain("notes.md");
    expect(proof.exitCode).toBe(0);
    expect(proof.stdout).toContain("Proof card created");
    await expect(readFile(proofPath, "utf8")).resolves.toContain("Proof Card");
    expect(report.stdout).toContain("Report");
    await expect(readFile(path.join(cwd, ".narthynx", "missions", id ?? "", "artifacts", "report.md"), "utf8")).resolves.toContain(
      "Proof card artifact: artifacts/proof-card.md"
    );
  });

  it("runs a read-only filesystem tool from the CLI", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const result = await runCli(["tool", id ?? "", "filesystem.list", "--input", "{\"path\":\".\"}"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\"entries\"");
  });

  it("reads safe files and refuses .env through the CLI", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    await writeFile(path.join(cwd, "notes.md"), "safe context\n", "utf8");
    await writeFile(path.join(cwd, ".env"), "TOKEN=secret\n", "utf8");
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const safe = await runCli(["tool", id ?? "", "filesystem.read", "--input", "{\"path\":\"notes.md\"}"], { cwd });
    const blocked = await runCli(["tool", id ?? "", "filesystem.read", "--input", "{\"path\":\".env\"}"], { cwd });

    expect(safe.exitCode).toBe(0);
    expect(safe.stdout).toContain("safe context");
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("blocked by policy");
  });

  it("creates a pending approval for approval-required tools from the CLI", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const result = await runCli(
      ["tool", id ?? "", "report.write", "--input", "{\"path\":\"report.md\",\"content\":\"report\"}"],
      { cwd }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires approval");
    expect(result.stderr).toContain("narthynx approve a_");
  });

  it("lists and approves pending approvals from the CLI", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const blocked = await runCli(
      ["tool", id ?? "", "report.write", "--input", "{\"path\":\"report.md\",\"content\":\"report\"}"],
      { cwd }
    );
    const approvalId = blocked.stderr.match(/approve (a_[^\s]+)/)?.[1];
    const list = await runCli(["approve"], { cwd });
    const approved = await runCli(["approve", approvalId ?? ""], { cwd });
    const timeline = await runCli(["timeline", id ?? ""], { cwd });

    expect(approvalId).toBeDefined();
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(approvalId);
    expect(approved.exitCode).toBe(0);
    expect(approved.stdout).toContain(`Approval approved: ${approvalId}`);
    expect(timeline.stdout).toContain("tool.approved");
  });

  it("approves filesystem.write, writes with a checkpoint, and rewinds the file", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const blocked = await runCli(
      ["tool", id ?? "", "filesystem.write", "--input", "{\"path\":\"launch.md\",\"content\":\"ready\\n\"}"],
      { cwd }
    );
    const approvalId = blocked.stderr.match(/approve (a_[^\s]+)/)?.[1];
    const approved = await runCli(["approve", approvalId ?? ""], { cwd });
    const checkpointId = approved.stdout.match(/checkpoint: (c_[^\s]+)/)?.[1];
    const timelineAfterWrite = await runCli(["timeline", id ?? ""], { cwd });
    const contentAfterWrite = await readFile(path.join(cwd, "launch.md"), "utf8");
    const rewound = await runCli(["rewind", id ?? "", checkpointId ?? ""], { cwd });
    const timelineAfterRewind = await runCli(["timeline", id ?? ""], { cwd });

    expect(approvalId).toBeDefined();
    expect(blocked.exitCode).toBe(1);
    expect(contentAfterWrite).toBe("ready\n");
    expect(approved.exitCode).toBe(0);
    expect(approved.stdout).toContain("Approved action executed");
    expect(checkpointId).toBeDefined();
    expect(timelineAfterWrite.stdout).toContain("checkpoint.created");
    expect(timelineAfterWrite.stdout).toContain("tool.completed");
    expect(rewound.exitCode).toBe(0);
    expect(rewound.stdout).toContain("file rollback: yes");
    await expect(readFile(path.join(cwd, "launch.md"), "utf8")).rejects.toThrow();
    expect(timelineAfterRewind.stdout).toContain("Checkpoint rewound");
  });

  it("replays approvals, checkpoints, tool completion, rewinds, and report artifacts", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const blocked = await runCli(
      ["tool", id ?? "", "filesystem.write", "--input", "{\"path\":\"launch.md\",\"content\":\"ready\\n\"}"],
      { cwd }
    );
    const approvalId = blocked.stderr.match(/approve (a_[^\s]+)/)?.[1];
    const approved = await runCli(["approve", approvalId ?? ""], { cwd });
    const checkpointId = approved.stdout.match(/checkpoint: (c_[^\s]+)/)?.[1];
    await runCli(["rewind", id ?? "", checkpointId ?? ""], { cwd });
    await runCli(["report", id ?? ""], { cwd });

    const result = await runCli(["replay", id ?? ""], { cwd });

    expect(approvalId).toBeDefined();
    expect(checkpointId).toBeDefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Approval requested: filesystem.write (${approvalId})`);
    expect(result.stdout).toContain(`Tool approved: filesystem.write (${approvalId})`);
    expect(result.stdout).toContain(`Checkpoint created: launch.md (${checkpointId})`);
    expect(result.stdout).toContain(`Tool completed: filesystem.write (${checkpointId})`);
    expect(result.stdout).toContain(`Checkpoint rewound: launch.md (${checkpointId})`);
    expect(result.stdout).toContain("Artifact created: artifacts/report.md");
  });

  it("runs the Phase 13 executor, pauses for approval, resumes, completes, reports, and replays", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const started = await runCli(["run", id ?? ""], { cwd });
    const approvalId = started.stdout.match(/Paused for approval: (a_[^\s]+)/)?.[1];
    const missionAfterRun = await runCli(["open", id ?? ""], { cwd });

    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain("Completed node: Inspect workspace (filesystem.list)");
    expect(started.stdout).toContain("Then: narthynx resume");
    expect(approvalId).toBeDefined();
    expect(missionAfterRun.stdout).toContain("state: waiting_for_approval");

    const approved = await runCli(["approve", approvalId ?? ""], { cwd });
    const resumed = await runCli(["resume", id ?? ""], { cwd });
    const reportPath = path.join(cwd, ".narthynx", "missions", id ?? "", "artifacts", "report.md");
    const replay = await runCli(["replay", id ?? ""], { cwd });

    expect(approved.exitCode).toBe(0);
    expect(approved.stdout).toContain("Approved action executed");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).toContain(`Mission completed: ${id}`);
    await expect(readFile(reportPath, "utf8")).resolves.toContain("State: completed");
    expect(replay.stdout).toContain("Node started: Understand goal");
    expect(replay.stdout).toContain("Node completed: Generate final report");
    expect(replay.stdout).toContain("Mission state changed: verifying -> completed");
  });

  it("fails clearly for a missing checkpoint rewind", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];
    const result = await runCli(["rewind", id ?? "", "c_missing"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to read checkpoint at");
  });

  it("denies pending approvals from the CLI", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const blocked = await runCli(
      ["tool", id ?? "", "report.write", "--input", "{\"path\":\"report.md\",\"content\":\"report\"}"],
      { cwd }
    );
    const approvalId = blocked.stderr.match(/approve (a_[^\s]+)/)?.[1];
    const denied = await runCli(["approve", approvalId ?? "", "--deny", "--reason", "not now"], { cwd });
    const timeline = await runCli(["timeline", id ?? ""], { cwd });

    expect(approvalId).toBeDefined();
    expect(denied.exitCode).toBe(0);
    expect(denied.stdout).toContain(`Approval denied: ${approvalId}`);
    expect(timeline.stdout).toContain("tool.denied");
  });

  it("executes approved report.write under the mission artifacts directory", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const blocked = await runCli(
      ["tool", id ?? "", "report.write", "--input", "{\"path\":\"report.md\",\"content\":\"approved report\"}"],
      { cwd }
    );
    const approvalId = blocked.stderr.match(/approve (a_[^\s]+)/)?.[1];
    const approved = await runCli(["approve", approvalId ?? ""], { cwd });
    const reportPath = path.join(cwd, ".narthynx", "missions", id ?? "", "artifacts", "report.md");

    expect(approvalId).toBeDefined();
    expect(approved.exitCode).toBe(0);
    expect(approved.stdout).toContain("Approved action executed");
    await expect(readFile(reportPath, "utf8")).resolves.toBe("approved report");
    await expect(readFile(path.join(cwd, "report.md"), "utf8")).rejects.toThrow();
  });

  it("fails clearly for a missing approval", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const result = await runCli(["approve", "a_missing"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Approval not found: a_missing");
  });

  it("fails clearly for a missing mission timeline", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const result = await runCli(["timeline", "m_missing"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to read mission at");
  });

  it("fails clearly for a missing mission replay", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const result = await runCli(["replay", "m_missing"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to read mission at");
  });

  it("fails clearly for a malformed replay ledger", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];
    const ledgerPath = path.join(cwd, ".narthynx", "missions", id ?? "", "ledger.jsonl");

    expect(id).toBeDefined();
    await writeFile(ledgerPath, "{not-json}\n", "utf8");
    const result = await runCli(["replay", id ?? ""], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${ledgerPath}:1`);
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

  it("fails clearly when pausing a missing mission", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const result = await runCli(["pause", "m_missing"], { cwd });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to read mission at");
  });

  it("fails model planning clearly when a cloud provider is configured but network policy is disabled", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];
    const previous = {
      provider: process.env.NARTHYNX_MODEL_PROVIDER,
      baseUrl: process.env.NARTHYNX_OPENAI_BASE_URL,
      apiKey: process.env.NARTHYNX_OPENAI_API_KEY,
      model: process.env.NARTHYNX_OPENAI_MODEL
    };

    process.env.NARTHYNX_MODEL_PROVIDER = "openai-compatible";
    process.env.NARTHYNX_OPENAI_BASE_URL = "https://models.example/v1";
    process.env.NARTHYNX_OPENAI_API_KEY = "sk-test-secret";
    process.env.NARTHYNX_OPENAI_MODEL = "planning-model";

    try {
      const result = await runCli(["plan", id ?? "", "--model"], { cwd });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("allow_network is false");
      expect(result.stderr).not.toContain("sk-test-secret");
    } finally {
      restoreEnv("NARTHYNX_MODEL_PROVIDER", previous.provider);
      restoreEnv("NARTHYNX_OPENAI_BASE_URL", previous.baseUrl);
      restoreEnv("NARTHYNX_OPENAI_API_KEY", previous.apiKey);
      restoreEnv("NARTHYNX_OPENAI_MODEL", previous.model);
    }
  });

  it("creates a pending approval for shell.run from the CLI", async () => {
    const cwd = await tempWorkspaceRoot();
    await runCli(["init"], { cwd });
    const created = await runCli(["mission", "Prepare launch checklist"], { cwd });
    const id = created.stdout.match(/id: (m_[^\s]+)/)?.[1];

    expect(id).toBeDefined();
    const result = await runCli(
      ["tool", id ?? "", "shell.run", "--input", JSON.stringify({ command: process.execPath, args: ["--version"] })],
      { cwd }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("shell.run requires approval");
    expect(result.stderr).toContain("narthynx approve a_");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
