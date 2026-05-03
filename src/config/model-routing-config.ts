import { readFile } from "node:fs/promises";

import YAML from "yaml";
import { z } from "zod";

import { modelTaskSchema } from "../agent/model-provider";

export const MODEL_ROUTING_FILE_NAME = "model-routing.yaml";

const endpointStubSchema = z.object({
  kind: z.literal("stub")
});

const endpointOpenAiSchema = z.object({
  kind: z.literal("openai_compatible"),
  base_url: z.string().min(1),
  model: z.string().min(1),
  api_key_env: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  max_tokens: z.number().int().min(1).max(128_000).optional(),
  temperature: z.number().min(0).max(2).optional()
});

const endpointSchema = z.discriminatedUnion("kind", [endpointStubSchema, endpointOpenAiSchema]);

const taskRouteSchema = z.object({
  primary: z.string().min(1),
  fallback: z.string().min(1).optional()
});

const budgetsSchema = z.object({
  max_total_tokens_per_mission: z.number().int().positive().optional(),
  max_estimated_cost_usd_per_mission: z.number().nonnegative().optional(),
  on_exceed: z.enum(["fail_closed", "downgrade_stub"]).optional().default("fail_closed")
});

export const modelRoutingConfigSchema = z.object({
  version: z.literal(1),
  tasks: z.record(modelTaskSchema, taskRouteSchema).optional(),
  endpoints: z.record(z.string().min(1), endpointSchema).default({}),
  budgets: budgetsSchema.optional()
});

export type ModelRoutingConfig = z.infer<typeof modelRoutingConfigSchema>;
export type ModelRoutingEndpoint = z.infer<typeof endpointSchema>;
export type ModelRoutingBudgets = z.infer<typeof budgetsSchema>;

export interface ModelRoutingLoadFailure {
  ok: false;
  path: string;
  message: string;
}

export interface ModelRoutingLoadSuccess {
  ok: true;
  path: string;
  value: ModelRoutingConfig;
}

export type ModelRoutingLoadResult = ModelRoutingLoadSuccess | ModelRoutingLoadFailure;

const EMPTY_CONFIG: ModelRoutingConfig = {
  version: 1,
  endpoints: {},
  tasks: undefined,
  budgets: undefined
};

export async function loadModelRoutingConfig(filePath: string): Promise<ModelRoutingLoadResult> {
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return { ok: true, path: filePath, value: EMPTY_CONFIG };
    }
    const message = error instanceof Error ? error.message : "Unknown read failure";
    return { ok: false, path: filePath, message };
  }

  let parsedJson: unknown;
  try {
    parsedJson = YAML.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid YAML";
    return { ok: false, path: filePath, message: `YAML parse error: ${message}` };
  }

  if (parsedJson === null || parsedJson === undefined) {
    return { ok: true, path: filePath, value: EMPTY_CONFIG };
  }

  const parsed = modelRoutingConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    return { ok: false, path: filePath, message };
  }

  const endpoints = parsed.data.endpoints;
  if (parsed.data.tasks) {
    for (const [task, route] of Object.entries(parsed.data.tasks)) {
      if (!endpoints[route.primary]) {
        return {
          ok: false,
          path: filePath,
          message: `tasks.${task}.primary references unknown endpoint "${route.primary}"`
        };
      }
      if (route.fallback && !endpoints[route.fallback]) {
        return {
          ok: false,
          path: filePath,
          message: `tasks.${task}.fallback references unknown endpoint "${route.fallback}"`
        };
      }
    }
  }

  return { ok: true, path: filePath, value: parsed.data };
}
