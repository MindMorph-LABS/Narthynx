import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "narthynx-test-mock", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo input text",
    inputSchema: { text: z.string() }
  },
  async ({ text }) => ({
    content: [{ type: "text", text: String(text) }]
  })
);

server.registerTool(
  "big",
  {
    description: "Return a large text blob",
    inputSchema: { bytes: z.number().int().min(1).max(2_000_000) }
  },
  async ({ bytes }) => ({
    content: [{ type: "text", text: "x".repeat(bytes) }]
  })
);

server.registerTool(
  "hang",
  {
    description: "Sleep for ms milliseconds",
    inputSchema: { ms: z.number().int().min(1) }
  },
  async ({ ms }) => {
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, ms);
    });
    return { content: [{ type: "text", text: "done" }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
