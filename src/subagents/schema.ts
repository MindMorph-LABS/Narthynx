import { z } from "zod";

import type { PlanGraph } from "../missions/graph";
export const SUBAGENT_PRINCIPAL_PREFIX = "subagent:";

export const subagentKindSchema = z.enum(["planner", "verifier", "safety", "critic"]);
export type SubagentKind = z.infer<typeof subagentKindSchema>;

export const riskBoundarySchema = z.enum(["low", "medium", "high"]);

export const subagentProfileSchema = z.object({
  kind: subagentKindSchema,
  allowedTools: z.array(z.string().min(1)).default([]),
  forbiddenTools: z.array(z.string().min(1)).default(["shell.run", "vault.read"]),
  maxTurns: z.number().int().min(0).max(50).default(1),
  maxToolCallsPerSession: z.number().int().min(0).max(500).default(0),
  maxModelCallsPerSession: z.number().int().min(0).max(100).default(2),
  riskBoundary: riskBoundarySchema.default("medium"),
  /** When true (planner only), persisted graph updates require `--apply --yes`. */
  requireExplicitApply: z.boolean().default(true)
});

export const subagentsConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean().default(true),
  profiles: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), subagentProfileSchema)
});

export type SubagentProfileResolved = z.infer<typeof subagentProfileSchema>;
export type SubagentsConfig = z.infer<typeof subagentsConfigSchema>;
export type SubagentProfileRaw = SubagentProfileResolved;

export interface VerifierCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

export const verifierResultSchema = z.object({
  ok: z.boolean(),
  severity: z.enum(["info", "warn", "error"]),
  checks: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      detail: z.string().optional()
    })
  ),
  summary: z.string().min(1)
});

export type VerifierResult = z.infer<typeof verifierResultSchema>;

export const safetyResultSchema = z.object({
  blocked: z.boolean(),
  severity: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.string()),
  heuristicNote: z.string().optional()
});

export type SafetyResult = z.infer<typeof safetyResultSchema>;

export const criticResultSchema = z.object({
  ok: z.boolean(),
  verifier: verifierResultSchema,
  safetySkipped: z.boolean().optional(),
  safety: safetyResultSchema.optional(),
  narrative: z.string().optional()
});

export type CriticResult = z.infer<typeof criticResultSchema>;

export interface PlannerProposal {
  rationale: string;
  proposedGraph: PlanGraph;
}