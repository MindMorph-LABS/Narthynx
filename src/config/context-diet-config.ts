import { readFile } from "node:fs/promises";

import YAML from "yaml";
import { z } from "zod";

import type { ValidationFailure, ValidationResult, ValidationSuccess } from "./load";

const fileTruncationSchema = z.object({
  max_bytes: z.number().int().min(1_024).max(20_000_000).default(48_000),
  head_lines: z.number().int().min(1).max(50_000).default(160),
  tail_lines: z.number().int().min(0).max(50_000).default(40)
});

export const contextDietConfigSchema = z.object({
  pack_max_bytes: z.number().int().min(4_096).max(20_000_000).default(350_000),
  pack_max_estimated_tokens: z.number().int().min(512).max(2_000_000).optional(),
  file_truncation: fileTruncationSchema.default({}),
  stale_policy: z.enum(["warn", "omit_from_pack"]).default("warn"),
  include_workspace_notes: z.boolean().default(false)
});

export type ContextDietConfig = z.infer<typeof contextDietConfigSchema>;
export type ContextDietFileTruncation = z.infer<typeof fileTruncationSchema>;

export const DEFAULT_CONTEXT_DIET_CONFIG: ContextDietConfig = contextDietConfigSchema.parse({});

export async function loadContextDietConfig(filePath: string): Promise<ValidationResult<ContextDietConfig>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = YAML.parse(raw);
    const result = contextDietConfigSchema.safeParse(parsed);

    if (!result.success) {
      const failure: ValidationFailure = {
        ok: false,
        path: filePath,
        message: result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")
      };
      return failure;
    }

    const success: ValidationSuccess<ContextDietConfig> = {
      ok: true,
      path: filePath,
      value: result.data
    };
    return success;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {
        ok: true,
        path: filePath,
        value: DEFAULT_CONTEXT_DIET_CONFIG
      };
    }

    return {
      ok: false,
      path: filePath,
      message: error instanceof Error ? error.message : "Unknown context-diet.yaml load failure"
    };
  }
}
