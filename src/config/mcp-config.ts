import { readFile } from "node:fs/promises";

import YAML from "yaml";
import { z } from "zod";

import type { ValidationFailure, ValidationResult, ValidationSuccess } from "./load";

export const mcpServerSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  maxOutputBytes: z.number().int().min(1_024).max(20_000_000).optional(),
  tools_allow: z.array(z.string()).optional(),
  tools_deny: z.array(z.string()).default([])
});

export const mcpConfigSchema = z.object({
  servers: z.array(mcpServerSchema).default([])
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpServerDefinition = z.infer<typeof mcpServerSchema>;

export async function loadMcpConfig(filePath: string): Promise<ValidationResult<McpConfig>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = YAML.parse(raw);
    const result = mcpConfigSchema.safeParse(parsed);

    if (!result.success) {
      const failure: ValidationFailure = {
        ok: false,
        path: filePath,
        message: result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")
      };
      return failure;
    }

    const success: ValidationSuccess<McpConfig> = {
      ok: true,
      path: filePath,
      value: result.data
    };
    return success;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      const success: ValidationSuccess<McpConfig> = {
        ok: true,
        path: filePath,
        value: { servers: [] }
      };
      return success;
    }

    const failure: ValidationFailure = {
      ok: false,
      path: filePath,
      message: error instanceof Error ? error.message : "Unknown YAML load failure"
    };
    return failure;
  }
}

export function findMcpServer(config: McpConfig, serverId: string): McpServerDefinition | undefined {
  return config.servers.find((s) => s.id === serverId);
}
