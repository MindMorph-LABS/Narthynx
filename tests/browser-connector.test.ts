import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("playwright", () => {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Example"),
    url: vi.fn().mockReturnValue("https://example.com/page"),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    locator: vi.fn().mockReturnValue({
      innerText: vi.fn().mockResolvedValue("hello page"),
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined)
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) }
  };
  const mockBrowser = {
    close: vi.fn().mockResolvedValue(undefined),
    newContext: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue(mockPage)
    })
  };
  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(mockBrowser)
    }
  };
});

import { mkdtemp, writeFile } from "node:fs/promises";
import { createApprovalStore } from "../src/missions/approvals";
import { createMissionStore } from "../src/missions/store";
import {
  classifyBrowserInputSafety,
  isBrowserToolName,
  urlAllowedForBrowser
} from "../src/tools/browser-guard";
import { classifyToolPolicy } from "../src/tools/policy";
import { createToolRegistry } from "../src/tools/registry";
import { createToolRunner } from "../src/tools/runner";
import type { WorkspacePolicy } from "../src/config/load";
import { initWorkspace } from "../src/config/workspace";

describe("browser guard", () => {
  const basePolicy: WorkspacePolicy = {
    mode: "ask",
    allow_network: false,
    shell: "ask",
    filesystem: {
      read: ["."],
      write: ["."],
      deny: []
    },
    external_communication: "block",
    credentials: "block",
    cloud_model_sensitive_context: "ask",
    browser: "block",
    browser_hosts_allow: [],
    browser_max_navigation_ms: 30_000,
    browser_max_steps_per_session: 50
  };

  it("detects browser tool names", () => {
    expect(isBrowserToolName("browser.navigate")).toBe(true);
    expect(isBrowserToolName("filesystem.list")).toBe(false);
  });

  it("matches URL prefixes and hostnames against allowlist", () => {
    const policy: WorkspacePolicy = {
      ...basePolicy,
      browser: "ask",
      browser_hosts_allow: ["https://example.com/", "other.org"]
    };
    expect(urlAllowedForBrowser("https://example.com/page", policy)).toBe(true);
    expect(urlAllowedForBrowser("https://api.other.org/", policy)).toBe(true);
    expect(urlAllowedForBrowser("https://evil.com/", policy)).toBe(false);
    expect(urlAllowedForBrowser("file:///etc/passwd", policy)).toBe(false);
  });

  it("skips URL checks when browser is blocked (policy handles denial)", () => {
    const policy: WorkspacePolicy = {
      ...basePolicy,
      browser: "block",
      browser_hosts_allow: []
    };
    expect(classifyBrowserInputSafety("browser.navigate", { url: "https://anywhere.test/" }, policy).ok).toBe(true);
  });

  it("rejects disallowed URLs when browser is ask", () => {
    const policy: WorkspacePolicy = {
      ...basePolicy,
      browser: "ask",
      allow_network: true,
      browser_hosts_allow: ["https://safe.example/"]
    };
    const bad = classifyBrowserInputSafety("browser.navigate", { url: "https://evil.test/" }, policy);
    expect(bad.ok).toBe(false);
  });
});

describe("browser policy classifier", () => {
  const basePolicy: WorkspacePolicy = {
    mode: "ask",
    allow_network: true,
    shell: "ask",
    filesystem: {
      read: ["."],
      write: ["."],
      deny: []
    },
    external_communication: "block",
    credentials: "block",
    cloud_model_sensitive_context: "ask",
    browser: "ask",
    browser_hosts_allow: ["https://example.com/"],
    browser_max_navigation_ms: 30_000,
    browser_max_steps_per_session: 50
  };

  it("blocks browser tools when browser is block even if allow_network is true", () => {
    const registry = createToolRegistry();
    const navigate = registry.get("browser.navigate");
    const policy: WorkspacePolicy = {
      ...basePolicy,
      browser: "block"
    };
    expect(classifyToolPolicy(navigate, policy).action).toBe("block");
  });

  it("blocks browser tools when ask but hosts allowlist is empty", () => {
    const registry = createToolRegistry();
    const navigate = registry.get("browser.navigate");
    const policy: WorkspacePolicy = {
      ...basePolicy,
      browser_hosts_allow: []
    };
    expect(classifyToolPolicy(navigate, policy).action).toBe("block");
  });
});

describe("browser tool runner (mocked playwright)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function workspaceWithBrowserPolicy(): Promise<{ cwd: string; missionId: string }> {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "narthynx-browser-"));
    await initWorkspace(cwd);
    const policyYaml = `mode: ask
allow_network: true
shell: ask
filesystem:
  read: ["."]
  write: ["."]
  deny:
    - ".env"
    - ".env.*"
external_communication: block
credentials: block
cloud_model_sensitive_context: ask
browser: ask
browser_hosts_allow:
  - "https://example.com/"
browser_max_navigation_ms: 30000
browser_max_steps_per_session: 50
`;
    await writeFile(path.join(cwd, ".narthynx", "policy.yaml"), policyYaml, "utf8");
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "Browser test" });
    return { cwd, missionId: mission.id };
  }

  it("runs browser.navigate after approval", async () => {
    const { cwd, missionId } = await workspaceWithBrowserPolicy();
    const runner = createToolRunner({ cwd });
    const pending = await runner.runTool({
      missionId,
      toolName: "browser.navigate",
      input: { url: "https://example.com/page" }
    });
    expect(pending.ok).toBe(false);
    expect(pending.blocked).toBe(true);
    expect(pending.approvalId).toMatch(/^a_/);

    const approvalStore = createApprovalStore(cwd);
    await approvalStore.decideApproval(pending.approvalId!, "approved");

    const done = await runner.runApprovedTool(pending.approvalId!);
    expect(done.ok).toBe(true);
    if (done.ok) {
      const out = done.output as { title: string; finalUrl: string };
      expect(out.title).toBe("Example");
      expect(out.finalUrl).toContain("example.com");
    }
  });
});
