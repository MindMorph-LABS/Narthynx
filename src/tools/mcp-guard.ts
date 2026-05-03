import { createHash } from "node:crypto";
import path from "node:path";

import type { McpConfig, McpServerDefinition } from "../config/mcp-config";
import { findMcpServer } from "../config/mcp-config";
import type { WorkspacePolicy } from "../config/load";

export const MAX_MCP_ARGUMENTS_JSON_BYTES = 256_000;

export function mcpArgumentsFingerprint(argumentsValue: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(argumentsValue)).digest("hex");
}

export function isMcpServerPolicyAllowed(policy: WorkspacePolicy, serverId: string): boolean {
  if (policy.mcp === "block") {
    return false;
  }
  if (policy.mcp_servers_allow !== undefined) {
    return policy.mcp_servers_allow.includes(serverId);
  }
  return true;
}

export function resolveMcpServerWorkingDirectory(rootDir: string, serverCwd: string | undefined): string {
  const rel = serverCwd?.trim() ? serverCwd.trim() : ".";
  const absolutePath = path.resolve(rootDir, rel);
  const relativeToRoot = path.relative(rootDir, absolutePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`MCP server cwd is outside the workspace: ${rel}`);
  }
  return absolutePath;
}

export function resolveMcpProcessEnv(envNames: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of envNames) {
    const v = process.env[name];
    if (v !== undefined) {
      out[name] = v;
    }
  }
  return out;
}

export function isToolInvocationAllowed(server: McpServerDefinition, toolName: string): { ok: boolean; reason?: string } {
  if (server.tools_deny.includes(toolName)) {
    return { ok: false, reason: `Tool ${toolName} is denied for MCP server ${server.id}.` };
  }
  if (server.tools_allow !== undefined && server.tools_allow.length > 0 && !server.tools_allow.includes(toolName)) {
    return {
      ok: false,
      reason: `Tool ${toolName} is not in tools_allow for MCP server ${server.id}.`
    };
  }
  return { ok: true };
}

export interface McpInputGuardContext {
  rootDir: string;
  policy: WorkspacePolicy;
  mcpConfig: McpConfig;
}

export function classifyMcpInputSafety(
  toolName: string,
  input: unknown,
  ctx: McpInputGuardContext
): { ok: boolean; reason?: string } {
  if (toolName === "mcp.servers.list") {
    return { ok: true };
  }

  if (typeof input !== "object" || input === null || !("serverId" in input)) {
    return { ok: false, reason: "MCP tools require serverId in input." };
  }
  const serverId = (input as { serverId: unknown }).serverId;
  if (typeof serverId !== "string" || serverId.length === 0) {
    return { ok: false, reason: "serverId must be a non-empty string." };
  }

  const server = findMcpServer(ctx.mcpConfig, serverId);
  if (!server) {
    return { ok: false, reason: `Unknown MCP server id: ${serverId}` };
  }

  if (!isMcpServerPolicyAllowed(ctx.policy, serverId)) {
    return { ok: false, reason: `MCP server ${serverId} is not allowed by policy.` };
  }

  if (toolName === "mcp.tools.list") {
    const refresh = "refresh" in input && (input as { refresh?: unknown }).refresh === true;
    if (refresh && ctx.policy.mode === "safe") {
      return { ok: false, reason: "Refreshing MCP tools list is blocked in safe policy mode." };
    }
    return { ok: true };
  }

  if (toolName === "mcp.tools.call") {
    const body = input as { name?: unknown; arguments?: unknown };
    if (typeof body.name !== "string" || body.name.length === 0) {
      return { ok: false, reason: "mcp.tools.call requires name (MCP tool name)." };
    }
    const toolAllowed = isToolInvocationAllowed(server, body.name);
    if (!toolAllowed.ok) {
      return toolAllowed;
    }
    const argsObj =
      body.arguments === undefined
        ? {}
        : typeof body.arguments === "object" && body.arguments !== null && !Array.isArray(body.arguments)
          ? (body.arguments as Record<string, unknown>)
          : undefined;
    if (argsObj === undefined) {
      return { ok: false, reason: "arguments must be an object when provided." };
    }
    const json = JSON.stringify(argsObj);
    if (Buffer.byteLength(json, "utf8") > MAX_MCP_ARGUMENTS_JSON_BYTES) {
      return {
        ok: false,
        reason: `MCP tool arguments exceed max size (${MAX_MCP_ARGUMENTS_JSON_BYTES} bytes).`
      };
    }
    return { ok: true };
  }

  return { ok: true };
}
