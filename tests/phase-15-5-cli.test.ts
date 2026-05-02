import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { routeInteractiveInput } from "../src/cli/input-router";
import { runInteractiveSession } from "../src/cli/interactive";
import { createReadlineRenderer } from "../src/cli/renderers/readline-renderer";
import { isSensitiveContextPath, parseShellShortcut } from "../src/cli/shortcuts";
import { workspaceNoteLooksSensitive } from "../src/cli/workspace-notes";
import { initWorkspace } from "../src/config/workspace";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-phase155-"));
}

describe("input router", () => {
  it("classifies natural language, slash, and shortcuts", () => {
    expect(routeInteractiveInput("  ").kind).toBe("empty");
    expect(routeInteractiveInput("/help").kind).toBe("slash");
    expect(routeInteractiveInput("! ls").kind).toBe("shell");
    expect(routeInteractiveInput("@ README.md").kind).toBe("context_file");
    expect(routeInteractiveInput("# note").kind).toBe("note");
    expect(routeInteractiveInput("Prepare launch")).toEqual({ kind: "natural", text: "Prepare launch" });
  });
});

describe("shortcut helpers", () => {
  it("parses shell shortcut tokens", () => {
    expect(parseShellShortcut("! node --version")).toEqual({ command: "node", args: ["--version"] });
  });

  it("flags sensitive context paths", () => {
    expect(isSensitiveContextPath(".env")).toBe(true);
    expect(isSensitiveContextPath("foo/.env")).toBe(true);
    expect(isSensitiveContextPath("secrets/id_rsa")).toBe(true);
    expect(isSensitiveContextPath("creds/deploy.pem")).toBe(true);
    expect(isSensitiveContextPath("key.ppk")).toBe(true);
    expect(isSensitiveContextPath(".ssh/id_ed25519")).toBe(true);
    expect(isSensitiveContextPath("readme.md")).toBe(false);
  });

  it("heuristically flags workspace notes that may contain secrets", () => {
    expect(workspaceNoteLooksSensitive("api_key=sk-xxx")).toBe(true);
    expect(workspaceNoteLooksSensitive("nothing special here")).toBe(false);
  });
});

describe("readline renderer", () => {
  it("renders intro and status lines", () => {
    let out = "";
    let err = "";
    const r = createReadlineRenderer({
      writeOut: (m) => {
        out += m;
      },
      writeErr: (m) => {
        err += m;
      }
    });

    r.intro({
      workspace: "/tmp/ws",
      policyLabel: "ask",
      cockpitMode: "ask",
      modelLabel: "auto",
      activeMissionId: "none"
    });

    expect(out).toContain("NARTHYNX");
    expect(out).toContain("Workspace: /tmp/ws");

    out = "";
    r.status({ cockpitMode: "ask", policyMode: "ask", modelLabel: "auto" });
    expect(out).toContain("Narthynx  mode: Ask");
    expect(out).toContain("policy: ask");
    expect(err).toBe("");
  });
});

describe("natural language routing", () => {
  it("creates a mission from plain text and hints /run", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const result = await runInteractiveSession({
      cwd,
      inputLines: ["Fix the flaky auth test in this repo", "/exit"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Mission created from your goal.");
    expect(result.stdout).toContain("Use /run to execute");
    expect(result.currentMissionId).toMatch(/^m_/);
  });

  it("records a note on existing mission and hints /run", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const result = await runInteractiveSession({
      cwd,
      inputLines: ['/mission "Audit deps"', "Focus on semver ranges first", "/exit"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Instruction recorded");
    expect(result.stdout).toContain("Run /run to continue");
  });

  it("warns before saving a sensitive-looking note to workspace-notes.md when no mission", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const result = await runInteractiveSession({
      cwd,
      inputLines: ["# api_key=supersecret", "/exit"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("may contain secrets");
    expect(result.stdout).toContain("workspace-notes.md");
  });

  it("/mode plan and /mode ask update session cockpit mode", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const result = await runInteractiveSession({
      cwd,
      inputLines: ["/mode plan", "/mode", "/mode ask", "/exit"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cockpit mode set to: plan");
    expect(result.stdout).toContain("Cockpit mode: plan (plan | ask)");
    expect(result.stdout).toContain("Cockpit mode set to: ask");
  });

  it("warns and skips @ attach for .env-like paths", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    await writeFile(path.join(cwd, ".env"), "SECRET=1\n", "utf8");

    const result = await runInteractiveSession({
      cwd,
      inputLines: ['/mission "x"', "@ .env", "/exit"]
    });

    expect(result.stderr).toContain("Refusing @ attach");
    expect(result.stderr).toContain(".env");
  });
});

describe("mission list in interactive shell", () => {
  it("lists missions from the workspace store", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    await runInteractiveSession({ cwd, inputLines: ['/mission "alpha"', "/exit"] });
    const result = await runInteractiveSession({ cwd, inputLines: ["/missions", "/exit"] });
    expect(result.stdout).toContain("Missions");
    expect(result.stdout).toMatch(/m_[a-z0-9_-]+/);
  });

  it("shows plan graph via /graph", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const result = await runInteractiveSession({
      cwd,
      inputLines: ['/mission "g"', "/graph", "/exit"]
    });

    expect(result.stdout).toContain("Graph for ");
    expect(result.stdout).toContain("nodes");
  });
});
