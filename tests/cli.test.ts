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

  it("fails honestly for mission runtime placeholders", async () => {
    const result = await runCli(["mission", "Prepare launch checklist"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not implemented in Phase 1");
  });
});
