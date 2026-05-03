import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_POLICY, defaultPolicyYaml } from "../src/config/defaults";
import { loadWorkspacePolicy } from "../src/config/load";
import { initWorkspace } from "../src/config/workspace";
import { createMissionStore } from "../src/missions/store";
import * as githubClient from "../src/tools/github-client";
import { classifyToolPolicy } from "../src/tools/policy";
import { createToolRegistry } from "../src/tools/registry";
import { createToolRunner } from "../src/tools/runner";

vi.mock("../src/tools/github-client", async () => {
  const actual = await vi.importActual("../src/tools/github-client");
  return {
    ...(actual as Record<string, unknown>),
    createOctokitForWorkspace: vi.fn()
  };
});

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-gh-"));
}

describe("GitHub connector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubClient.createOctokitForWorkspace).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks GitHub tools when policy github is block", () => {
    const tool = createToolRegistry().get("github.repos.get");
    expect(classifyToolPolicy(tool, DEFAULT_POLICY).action).toBe("block");
  });

  it("classifies read tool as allow when github and external_comm are ask", () => {
    const tool = createToolRegistry().get("github.repos.get");
    const policy = {
      ...DEFAULT_POLICY,
      github: "ask",
      external_communication: "ask"
    } as const;
    const d = classifyToolPolicy(tool, policy);
    expect(d.action).toBe("allow");
  });

  it("runner blocks when external_communication is block", async () => {
    vi.stubEnv("GITHUB_TOKEN", "fake-token-for-test");
    const cwd = await tempRoot();
    await initWorkspace(cwd);
    const policyPath = path.join(cwd, ".narthynx", "policy.yaml");
    await writeFile(
      policyPath,
      defaultPolicyYaml().replace("github: block", "github: ask").replace("external_communication: block", "external_communication: block"),
      "utf8"
    );

    const pol = await loadWorkspacePolicy(policyPath);
    expect(pol.ok && pol.value.github).toBe("ask");
    expect(pol.ok && pol.value.external_communication).toBe("block");

    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "gh" });
    const runner = createToolRunner({ cwd });

    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "github.repos.get",
      input: { owner: "org", repo: "r" }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
      expect(result.message).toContain("External communication is blocked");
    }
  });

  it("runner blocks repo not in effective allowlist", async () => {
    vi.stubEnv("GITHUB_TOKEN", "fake-token-for-test");
    const cwd = await tempRoot();
    await initWorkspace(cwd);
    const policyPath = path.join(cwd, ".narthynx", "policy.yaml");
    await writeFile(
      policyPath,
      defaultPolicyYaml()
        .replace("github: block", "github: ask")
        .replace("external_communication: block", "external_communication: ask")
        .trimEnd() +
        "\ngithub_repos_allow:\n  - allowed/other\n",
      "utf8"
    );
    await writeFile(path.join(cwd, ".narthynx", "github.yaml"), "repos_allow:\n  - allowed/other\n", "utf8");

    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "gh" });
    const runner = createToolRunner({ cwd });

    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "github.repos.get",
      input: { owner: "evilcorp", repo: "x" }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
      expect(result.message).toMatch(/allowlist/i);
    }
  });

  it("runs github.repos.get when policy permits and API returns data", async () => {
    vi.stubEnv("GITHUB_TOKEN", "fake-token-for-test");
    const mockGet = vi.fn().mockResolvedValue({ data: { name: "hello", full_name: "org/hello" } });
    vi.mocked(githubClient.createOctokitForWorkspace).mockResolvedValue({
      ok: true,
      octokit: {
        rest: {
          repos: { get: mockGet }
        }
      } as never,
      timeoutMs: 5_000,
      maxResponseBytes: 500_000
    });

    const cwd = await tempRoot();
    await initWorkspace(cwd);
    const policyPath = path.join(cwd, ".narthynx", "policy.yaml");
    await writeFile(
      policyPath,
      defaultPolicyYaml().replace("github: block", "github: ask").replace("external_communication: block", "external_communication: ask"),
      "utf8"
    );

    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "gh" });
    const runner = createToolRunner({ cwd });

    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "github.repos.get",
      input: { owner: "org", repo: "hello" }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.output as { data: { name: string }; truncated: boolean };
      expect(out.data.name).toBe("hello");
      expect(out.truncated).toBe(false);
    }
    expect(mockGet).toHaveBeenCalledOnce();
  });

  it("writes artifact when GitHub JSON exceeds maxResponseBytes", async () => {
    vi.stubEnv("GITHUB_TOKEN", "fake-token-for-test");
    const huge = { blobs: "x".repeat(600_000) };
    const mockGet = vi.fn().mockResolvedValue({ data: huge });
    vi.mocked(githubClient.createOctokitForWorkspace).mockResolvedValue({
      ok: true,
      octokit: {
        rest: {
          repos: { get: mockGet }
        }
      } as never,
      timeoutMs: 5_000,
      maxResponseBytes: 10_000
    });

    const cwd = await tempRoot();
    await initWorkspace(cwd);
    const policyPath = path.join(cwd, ".narthynx", "policy.yaml");
    await writeFile(
      policyPath,
      defaultPolicyYaml().replace("github: block", "github: ask").replace("external_communication: block", "external_communication: ask"),
      "utf8"
    );

    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "gh" });
    const runner = createToolRunner({ cwd });

    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "github.repos.get",
      input: { owner: "org", repo: "hello" }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.output as { truncated: boolean; artifactPath?: string; data: { _spillover?: boolean } };
      expect(out.truncated).toBe(true);
      expect(out.artifactPath).toBeDefined();
      expect(out.data).toMatchObject({ _spillover: true });
    }
  });

  it("requires approval for github.issues.createComment", async () => {
    vi.stubEnv("GITHUB_TOKEN", "fake-token-for-test");
    const cwd = await tempRoot();
    await initWorkspace(cwd);
    const policyPath = path.join(cwd, ".narthynx", "policy.yaml");
    await writeFile(
      policyPath,
      defaultPolicyYaml().replace("github: block", "github: ask").replace("external_communication: block", "external_communication: ask"),
      "utf8"
    );

    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "gh" });
    const runner = createToolRunner({ cwd });

    const result = await runner.runTool({
      missionId: mission.id,
      toolName: "github.issues.createComment",
      input: { owner: "org", repo: "r", issue_number: 1, body: "hi" }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
      expect(result.approvalId).toBeDefined();
      expect(result.message).toContain("approve");
    }
  });

  it("formats API errors without leaking token-shaped text", () => {
    const o = { status: 401, message: "Bad credentials" };
    const msg = githubClient.formatGithubRequestError(o);
    expect(msg).toContain("401");
    expect(msg).not.toMatch(/ghp_[a-zA-Z0-9]+/);
  });
});
