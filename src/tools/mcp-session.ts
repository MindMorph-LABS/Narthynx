import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { McpServerDefinition } from "../config/mcp-config";
import { resolveMcpProcessEnv, resolveMcpServerWorkingDirectory } from "./mcp-guard";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface McpCallResultJson {
  content: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

function stringifyResultForSize(result: McpCallResultJson): string {
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export async function runMcpWithClient<T>(
  server: McpServerDefinition,
  rootDir: string,
  timeoutMs: number,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const cwd = resolveMcpServerWorkingDirectory(rootDir, server.cwd);
  const extraEnv = resolveMcpProcessEnv(server.env);
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd,
    env: { ...process.env, ...extraEnv } as Record<string, string>,
    stderr: "pipe"
  });
  const client = new Client({ name: "narthynx", version: "0.1.0" });

  const run = async (): Promise<T> => {
    await client.connect(transport);
    return fn(client);
  };

  try {
    return await Promise.race([
      run(),
      sleep(timeoutMs).then(() => {
        throw new Error(`MCP timed out after ${timeoutMs}ms`);
      })
    ]);
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
  }
}

export async function mcpListTools(
  server: McpServerDefinition,
  rootDir: string,
  timeoutMs: number
): Promise<
  Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>
> {
  return runMcpWithClient(server, rootDir, timeoutMs, async (client) => {
    const listed = await client.listTools();
    return listed.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
  });
}

export async function mcpCallTool(
  server: McpServerDefinition,
  rootDir: string,
  timeoutMs: number,
  name: string,
  args: Record<string, unknown>
): Promise<McpCallResultJson> {
  return runMcpWithClient(server, rootDir, timeoutMs, async (client) => {
    const result = await client.callTool({
      name,
      arguments: args
    });
    return {
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError
    };
  });
}

export function mcpResultByteLength(result: McpCallResultJson): number {
  return Buffer.byteLength(stringifyResultForSize(result), "utf8");
}

export function truncateMcpResultForInline(
  result: McpCallResultJson,
  maxBytes: number
): {
  inline: McpCallResultJson | string;
  truncated: boolean;
} {
  const s = stringifyResultForSize(result);
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) {
    return { inline: result, truncated: false };
  }
  return {
    inline: `${buf.subarray(0, maxBytes).toString("utf8")}\n[truncated to ${maxBytes} bytes]`,
    truncated: true
  };
}
