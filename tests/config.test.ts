import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, DEFAULT_POLICY, defaultConfigYaml, defaultPolicyYaml } from "../src/config/defaults";
import { loadWorkspaceConfig, loadWorkspacePolicy } from "../src/config/load";
import { doctorWorkspace, initWorkspace } from "../src/config/workspace";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-config-"));
}

describe("workspace init", () => {
  it("creates the Phase 1 workspace files and folders", async () => {
    const cwd = await tempWorkspaceRoot();
    const result = await initWorkspace(cwd);

    expect(result.failed).toEqual([]);
    expect(result.created).toContain(path.join(cwd, ".narthynx"));
    expect(result.created).toContain(path.join(cwd, ".narthynx", "missions"));
    expect(result.created).toContain(path.join(cwd, ".narthynx", "config.yaml"));
    expect(result.created).toContain(path.join(cwd, ".narthynx", "policy.yaml"));
    await expect(readFile(path.join(cwd, ".narthynx", "config.yaml"), "utf8")).resolves.toContain(
      "workspace_version"
    );
  });

  it("preserves existing config and policy when run twice", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const configPath = path.join(cwd, ".narthynx", "config.yaml");
    const policyPath = path.join(cwd, ".narthynx", "policy.yaml");
    const customConfig = `${defaultConfigYaml()}# user note\n`;
    const customPolicy = `${defaultPolicyYaml()}# user policy note\n`;

    await writeFile(configPath, customConfig, "utf8");
    await writeFile(policyPath, customPolicy, "utf8");

    const result = await initWorkspace(cwd);

    expect(result.failed).toEqual([]);
    expect(result.preserved).toContain(configPath);
    expect(result.preserved).toContain(policyPath);
    await expect(readFile(configPath, "utf8")).resolves.toBe(customConfig);
    await expect(readFile(policyPath, "utf8")).resolves.toBe(customPolicy);
  });

  it("recreates missing workspace pieces without overwriting preserved files", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const configPath = path.join(cwd, ".narthynx", "config.yaml");
    const missionsPath = path.join(cwd, ".narthynx", "missions");
    const customConfig = `${defaultConfigYaml()}# keep me\n`;
    await writeFile(configPath, customConfig, "utf8");
    await rm(missionsPath, { recursive: true, force: true });

    const result = await initWorkspace(cwd);

    expect(result.failed).toEqual([]);
    expect(result.preserved).toContain(configPath);
    expect(result.created).toContain(missionsPath);
    await expect(readFile(configPath, "utf8")).resolves.toBe(customConfig);
  });
});

describe("config and policy loading", () => {
  it("loads default config with required fields", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const result = await loadWorkspaceConfig(path.join(cwd, ".narthynx", "config.yaml"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(DEFAULT_CONFIG);
    }
  });

  it("loads default policy with safe defaults", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const result = await loadWorkspacePolicy(path.join(cwd, ".narthynx", "policy.yaml"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe("ask");
      expect(result.value.allow_network).toBe(false);
      expect(result.value.shell).toBe("ask");
      expect(result.value.filesystem.read).toEqual(["."]);
      expect(result.value.filesystem.write).toEqual(["."]);
      expect(result.value.filesystem.deny).toEqual(expect.arrayContaining([".env", ".env.*", "~/.ssh/**"]));
      expect(result.value.credentials).toBe("block");
      expect(result.value).toEqual(DEFAULT_POLICY);
    }
  });

  it("returns typed validation failures for invalid YAML and missing fields", async () => {
    const cwd = await tempWorkspaceRoot();
    const workspaceDir = path.join(cwd, ".narthynx");
    await mkdir(workspaceDir, { recursive: true });

    const invalidYamlPath = path.join(workspaceDir, "config.yaml");
    const invalidPolicyPath = path.join(workspaceDir, "policy.yaml");
    await writeFile(invalidYamlPath, "workspace_version: [", "utf8");
    await writeFile(invalidPolicyPath, "mode: ask\n", "utf8");

    const config = await loadWorkspaceConfig(invalidYamlPath);
    const policy = await loadWorkspacePolicy(invalidPolicyPath);

    expect(config.ok).toBe(false);
    expect(policy.ok).toBe(false);
    if (!policy.ok) {
      expect(policy.message).toContain("allow_network");
    }
  });
});

describe("workspace doctor", () => {
  it("fails before init and passes after init", async () => {
    const cwd = await tempWorkspaceRoot();

    const before = await doctorWorkspace(cwd);
    expect(before.ok).toBe(false);

    await initWorkspace(cwd);
    const after = await doctorWorkspace(cwd);
    expect(after.ok).toBe(true);
  });
});
