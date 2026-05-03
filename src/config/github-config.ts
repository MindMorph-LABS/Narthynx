import { readFile } from "node:fs/promises";

import YAML from "yaml";
import { z } from "zod";

import type { ValidationFailure, ValidationResult, ValidationSuccess } from "./load";

export const githubConfigSchema = z.object({
  defaultOwner: z.string().min(1).optional(),
  repos_allow: z.array(z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)).optional(),
  /** GitHub Enterprise: e.g. https://github.mycompany.com/api/v3 */
  baseUrl: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(3_000).max(120_000).optional(),
  maxResponseBytes: z.number().int().min(1_024).max(20_000_000).optional()
});

export type GithubConfig = z.infer<typeof githubConfigSchema>;

export const defaultGithubConfigValues = {
  timeoutMs: 30_000,
  maxResponseBytes: 500_000
} as const;

export async function loadGithubConfig(filePath: string): Promise<ValidationResult<GithubConfig>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = YAML.parse(raw);
    const result = githubConfigSchema.safeParse(parsed ?? {});

    if (!result.success) {
      const failure: ValidationFailure = {
        ok: false,
        path: filePath,
        message: result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")
      };
      return failure;
    }

    const success: ValidationSuccess<GithubConfig> = {
      ok: true,
      path: filePath,
      value: result.data
    };
    return success;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      const success: ValidationSuccess<GithubConfig> = {
        ok: true,
        path: filePath,
        value: {}
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

export function normalizeRepoAllowEntry(ref: string): string {
  return ref.trim().toLowerCase();
}
