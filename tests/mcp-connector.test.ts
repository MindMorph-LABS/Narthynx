import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { defaultPolicyYaml } from "../src/config/defaults";
import { initWorkspace } from "../src/config/workspace";
import { createApprovalStore } from "../src/missions/approvals";
import { createMissionStore } from "../src/missions/store";
import { createToolRegistry } from "../src/tools/registry";
import { createToolRunner } from "../src/tools/runner";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const mockServerScript = path.join(repoRoot, "tests", "fixtures", "mock-mcp-server.mjs");

async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-mcp-"));
}

function baseMcpServer(overrides: Record<string, unknown> = {}) {
  return {
    id: "mock",
    command: process.execPath,
    args: [mockServerScript],
    timeoutMs: 20_000,
    maxOutputBytes: 50_000,
    tools_allow: ["echo", "big", "hang"],
    tools_deny: [],
    ...overrides
  };
}

async function writeMcpAndPolicy(
  cwd: string,
  options: {
    policyMode?: string;
    mcpMode?: string;
    externalComm?: string;
    allowServers?: string[];
    serverOverrides?: Record<string, unknown>;
  } = {}
): Promise<void> {
  const {
    policyMode = "trusted",
    mcpMode = "ask",
    externalComm = "ask",
    allowServers = ["mock"],
    serverOverrides
  } = options;

  const mcpYaml = YAML.stringify({
    servers: [baseMcpServer(serverOverrides)]
  });
  await writeFile(path.join(cwd, ".narthynx", "mcp.yaml"), `${mcpYaml}\n`, "utf8");

  const policy = YAML.parse(defaultPolicyYaml()) as Record<string, unknown>;
  policy.mode = policyMode;
  policy.mcp = mcpMode;
  policy.external_communication = externalComm;
  policy.mcp_servers_allow = allowServers;
  await writeFile(path.join(cwd, ".narthynx", "policy.yaml"), `${YAML.stringify(policy)}\n`, "utf8");
}

describe.sequential("MCP connector", () => {
  it("blocks all MCP tools when policy mcp is block", async () => {
    const cwd = await tempCwd();
    await initWorkspace(cwd);
    await writeMcpAndPolicy(cwd, { mcpMode: "block", policyMode: "trusted", externalComm: "ask" });

    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "t" });
    const runner = createToolRunner({ cwd, registry: createToolRegistry() });

    const res = await runner.runTool({
      missionId: mission.id,
      toolName: "mcp.servers.list",
      input: {}
    });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.message).toContain("MCP is blocked");
  });

  it("denies mcp.tools.call when tool is not in tools_allow", async () => {
    const cwd = await tempCwd();
    await initWorkspace(cwd);
    await writeMcpAndPolicy(cwd);

    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "t" });
    const runner = createToolRunner({ cwd, registry: createToolRegistry() });

    const res = await runner.runTool({
      missionId: mission.id,
      toolName: "mcp.tools.call",
      input: { serverId: "mock", name: "unknown_tool", arguments: {} }
    });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.message).toContain("not in tools_allow");
  });

  it(
    "runs echo through MCP after approval",
    async () => {
    const cwd = await tempCwd();
    await initWorkspace(cwd);
    await writeMcpAndPolicy(cwd, { policyMode: "ask", externalComm: "ask" });

    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "t" });
    const runner = createToolRunner({ cwd, registry: createToolRegistry() });
    const approvals = createApprovalStore(cwd);

    const pending = await runner.runTool({
      missionId: mission.id,
      toolName: "mcp.tools.call",
      input: { serverId: "mock", name: "echo", arguments: { text: "hello-mcp" } }
    });
    expect(pending.ok).toBe(false);
    expect(pending.blocked).toBe(true);
    expect(pending.approvalId).toBeDefined();

    await approvals.decideApproval(pending.approvalId ?? "", "approved");
    const done = await runner.runApprovedTool(pending.approvalId ?? "");
    expect(done.ok).toBe(true);
    if (done.ok) {
      const out = done.output as { content: unknown; toolName: string; argumentsFingerprint: string };
      expect(out.toolName).toBe("echo");
      expect(out.argumentsFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(out.content)).toContain("hello-mcp");
    }
    },
    60_000
  );

  it("spills large MCP results to an artifact when over maxOutputBytes", async () => {
    const cwd = await tempCwd();
    await initWorkspace(cwd);
    await writeMcpAndPolicy(cwd, {
      serverOverrides: { maxOutputBytes: 1024, timeoutMs: 20_000 }
    });

    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "t" });
    const runner = createToolRunner({ cwd, registry: createToolRegistry() });
    const approvals = createApprovalStore(cwd);

    const pending = await runner.runTool({
      missionId: mission.id,
      toolName: "mcp.tools.call",
      input: { serverId: "mock", name: "big", arguments: { bytes: 5000 } }
    });
    expect(pending.approvalId).toBeDefined();
    await approvals.decideApproval(pending.approvalId ?? "", "approved");
    const done = await runner.runApprovedTool(pending.approvalId ?? "");
    expect(done.ok).toBe(true);
    if (done.ok) {
      const out = done.output as { artifactPath?: string; truncated: boolean; resultBytes: number };
      expect(out.truncated).toBe(true);
      expect(out.artifactPath).toBeDefined();
      expect(out.resultBytes).toBeGreaterThan(1024);
    }
  });

  it("fails closed on MCP timeout", async () => {
    const cwd = await tempCwd();
    await initWorkspace(cwd);
    await writeMcpAndPolicy(cwd, {
      serverOverrides: { timeoutMs: 1500, maxOutputBytes: 50_000 }
    });

    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "t" });
    const runner = createToolRunner({ cwd, registry: createToolRegistry() });
    const approvals = createApprovalStore(cwd);

    const pending = await runner.runTool({
      missionId: mission.id,
      toolName: "mcp.tools.call",
      input: { serverId: "mock", name: "hang", arguments: { ms: 10_000 } }
    });
    expect(pending.approvalId).toBeDefined();
    await approvals.decideApproval(pending.approvalId ?? "", "approved");
    const done = await runner.runApprovedTool(pending.approvalId ?? "");
    expect(done.ok).toBe(false);
    if (!done.ok) {
      expect(done.message).toContain("timed out");
    }
  });

  it("lists tools from mock MCP server (live)", async () => {
    const cwd = await tempCwd();
    await initWorkspace(cwd);
    await writeMcpAndPolicy(cwd);

    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({ goal: "t" });
    const runner = createToolRunner({ cwd, registry: createToolRegistry() });

    const res = await runner.runTool({
      missionId: mission.id,
      toolName: "mcp.tools.list",
      input: { serverId: "mock", refresh: true }
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const out = res.output as { source: string; tools: Array<{ name: string }> };
      expect(out.source).toBe("live");
      expect(out.tools.map((t) => t.name).sort()).toEqual(["big", "echo", "hang"]);
    }
  });
});
