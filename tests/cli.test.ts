import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { PLACEHOLDER_COMMANDS, runCli } from "../src/cli/index";

describe("Narthynx Phase 0 CLI", () => {
  it("prints help with product identity and required command names", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Narthynx");
    expect(result.stdout).toContain("local-first Mission Agent OS");

    for (const command of PLACEHOLDER_COMMANDS) {
      expect(result.stdout).toContain(command);
    }
  });

  it("prints a version matching package.json", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const result = await runCli(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it("fails honestly for placeholder commands", async () => {
    const result = await runCli(["init"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not implemented in Phase 0");
  });
});
