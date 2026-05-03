import { z } from "zod";

export const modelTaskSchema = z.enum([
  "intent_classification",
  "planning",
  "file_summarization",
  "tool_argument_drafting",
  "risk_classification",
  "final_report",
  /** Frontier F17 — conversational companion; JSON-only structured output */
  "companion_chat",
  /** Frontier F20 — bounded subagents (stub-friendly routing keys) */
  "subagent_planner",
  "subagent_verifier",
  "subagent_safety"
]);

export const modelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional()
});

export const modelCostSchema = z.object({
  estimatedCost: z.number().nonnegative(),
  currency: z.string().min(1).default("USD")
});

export const modelCallRequestSchema = z.object({
  missionId: z.string().regex(/^m_[a-z0-9_-]+$/),
  task: modelTaskSchema,
  purpose: z.string().min(1),
  input: z.unknown(),
  sensitiveContextIncluded: z.boolean().default(false)
});

export const modelCallResponseSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  content: z.string(),
  usage: modelUsageSchema.optional(),
  cost: modelCostSchema.optional(),
  latencyMs: z.number().nonnegative()
});

export type ModelTask = z.infer<typeof modelTaskSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;
export type ModelCost = z.infer<typeof modelCostSchema>;
export type ModelCallRequest = z.infer<typeof modelCallRequestSchema>;
export type ModelCallResponse = z.infer<typeof modelCallResponseSchema>;

export interface ModelProvider {
  name: string;
  model: string;
  isNetworked: boolean;
  call(request: ModelCallRequest): Promise<ModelCallResponse>;
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly meta?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

export function summarizeUsage(usage: ModelUsage | undefined): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  if (!usage) {
    return {};
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  };
}
