import type { WorkspacePolicy } from "../config/load";
import type { RiskLevel } from "../missions/schema";
import { isBrowserToolName } from "./browser-guard";
import type { ToolAction, ToolSideEffect } from "./types";

export type ToolPolicyDecision =
  | {
      action: "allow";
      reason: string;
      riskLevel: RiskLevel;
    }
  | {
      action: "approval";
      reason: string;
      riskLevel: RiskLevel;
    }
  | {
      action: "block";
      reason: string;
      riskLevel: RiskLevel;
    };

function extractMcpServerId(toolInput: unknown): string | undefined {
  if (typeof toolInput === "object" && toolInput !== null && "serverId" in toolInput) {
    const v = (toolInput as { serverId: unknown }).serverId;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

export function classifyToolPolicy(
  tool: ToolAction<unknown, unknown>,
  policy: WorkspacePolicy,
  toolInput?: unknown
): ToolPolicyDecision {
  if (isBrowserToolName(tool.name)) {
    if (policy.browser === "block") {
      return block(tool, "Browser tools are blocked by policy (browser: block).");
    }
    if (policy.browser === "ask" && policy.browser_hosts_allow.length === 0) {
      return block(
        tool,
        "Browser tools require at least one entry in browser_hosts_allow when browser is ask."
      );
    }
  }

  if (tool.name.startsWith("mcp.")) {
    if (policy.mcp === "block") {
      return block(tool, "MCP is blocked by policy (mcp: block).");
    }
    if (policy.mcp_servers_allow !== undefined && tool.name !== "mcp.servers.list") {
      const sid = extractMcpServerId(toolInput);
      if (!sid) {
        return block(tool, "MCP tool requires serverId for mcp_servers_allow policy check.");
      }
      if (!policy.mcp_servers_allow.includes(sid)) {
        return block(tool, `MCP server ${sid} is not listed in mcp_servers_allow.`);
      }
    }
  }

  if (tool.sideEffect === "network" && !policy.allow_network) {
    return block(tool, "Network tools are blocked by default policy.");
  }

  if (tool.sideEffect === "external_comm" && policy.external_communication === "block") {
    return block(tool, "External communication is blocked by policy.");
  }

  if (tool.sideEffect === "credential" && policy.credentials === "block") {
    return block(tool, "Credential access is blocked by policy.");
  }

  if (tool.sideEffect === "shell" && policy.shell === "block") {
    return block(tool, "Shell tools are blocked by policy.");
  }

  if (tool.riskLevel === "critical") {
    return block(tool, "Critical-risk tools require a future explicit typed confirmation workflow.");
  }

  if (policy.mode === "safe" && !isLowRiskRead(tool)) {
    return block(tool, "Safe mode allows read-only low-risk tools only.");
  }

  if (tool.requiresApproval) {
    return approval(tool, "Tool metadata requires approval.");
  }

  switch (policy.mode) {
    case "safe":
      return allow(tool, "Safe mode allows low-risk local reads.");
    case "ask":
      return tool.riskLevel === "low" ? allow(tool, "Ask mode allows low-risk tools.") : approval(tool, "Ask mode requires approval for medium and high risk.");
    case "trusted":
      return tool.riskLevel === "high"
        ? approval(tool, "Trusted mode requires approval for high risk.")
        : allow(tool, "Trusted mode allows low and medium risk tools.");
    case "approval":
      return isLowRiskRead(tool)
        ? allow(tool, "Approval mode allows harmless low-risk local reads.")
        : approval(tool, "Approval mode requires approval for non-trivial tools.");
  }
}

function isLowRiskRead(tool: ToolAction<unknown, unknown>): boolean {
  return tool.riskLevel === "low" && isReadLikeSideEffect(tool.sideEffect);
}

function isReadLikeSideEffect(sideEffect: ToolSideEffect): boolean {
  return sideEffect === "none" || sideEffect === "local_read";
}

function allow(tool: ToolAction<unknown, unknown>, reason: string): ToolPolicyDecision {
  return {
    action: "allow",
    reason,
    riskLevel: tool.riskLevel
  };
}

function approval(tool: ToolAction<unknown, unknown>, reason: string): ToolPolicyDecision {
  return {
    action: "approval",
    reason,
    riskLevel: tool.riskLevel
  };
}

function block(tool: ToolAction<unknown, unknown>, reason: string): ToolPolicyDecision {
  return {
    action: "block",
    reason,
    riskLevel: tool.riskLevel
  };
}
