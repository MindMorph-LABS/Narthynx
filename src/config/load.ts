import { readFile } from "node:fs/promises";

import YAML from "yaml";
import { z } from "zod";

export const configSchema = z.object({
  workspace_version: z.literal(1),
  created_by: z.literal("narthynx"),
  default_policy: z.string().min(1),
  missions_dir: z.string().min(1)
});

export const policySchema = z.object({
  mode: z.enum(["safe", "ask", "trusted", "approval"]),
  allow_network: z.boolean(),
  shell: z.enum(["block", "ask"]),
  filesystem: z.object({
    read: z.array(z.string()).min(1),
    write: z.array(z.string()).min(1),
    deny: z.array(z.string()).min(1)
  }),
  external_communication: z.enum(["block", "ask"]),
  credentials: z.enum(["block", "ask"]),
  cloud_model_sensitive_context: z.enum(["block", "ask", "allow"]),
  /** When `block`, browser tools are denied regardless of `allow_network`. */
  browser: z.enum(["block", "ask"]).default("block"),
  /** URL prefixes or hostnames allowed for browser tool navigation. Non-empty required when `browser` is `ask` and tools run. */
  browser_hosts_allow: z.array(z.string().min(1)).default([]),
  /** Max time (ms) for navigation and Playwright defaults per action. */
  browser_max_navigation_ms: z.number().int().min(3_000).max(120_000).default(30_000),
  /** Bound for future multi-step session reuse (v2). */
  browser_max_steps_per_session: z.number().int().min(1).max(100).default(50)
});

export type WorkspaceConfig = z.infer<typeof configSchema>;
export type WorkspacePolicy = z.output<typeof policySchema>;

export interface ValidationFailure {
  ok: false;
  path: string;
  message: string;
}

export interface ValidationSuccess<T> {
  ok: true;
  path: string;
  value: T;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export async function loadWorkspaceConfig(path: string): Promise<ValidationResult<WorkspaceConfig>> {
  return loadYamlFile(path, configSchema);
}

export async function loadWorkspacePolicy(path: string): Promise<ValidationResult<WorkspacePolicy>> {
  const result = await loadYamlFile(path, policySchema);
  if (!result.ok) {
    return result;
  }
  return { ok: true, path: result.path, value: result.value as WorkspacePolicy };
}

async function loadYamlFile<T>(path: string, schema: z.ZodSchema<T>): Promise<ValidationResult<T>> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = YAML.parse(raw);
    const result = schema.safeParse(parsed);

    if (!result.success) {
      return {
        ok: false,
        path,
        message: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      };
    }

    return {
      ok: true,
      path,
      value: result.data
    };
  } catch (error) {
    return {
      ok: false,
      path,
      message: error instanceof Error ? error.message : "Unknown YAML load failure"
    };
  }
}
