import { z } from "zod";

export const missionStateSchema = z.enum([
  "created",
  "planning",
  "running",
  "waiting_for_approval",
  "paused",
  "verifying",
  "failed",
  "recovering",
  "completed",
  "cancelled"
]);

export const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const missionContextSchema = z.object({
  notes: z.array(z.string()),
  files: z.array(z.string())
});

export const missionPlanGraphSchema = z.object({
  missionId: z.string().regex(/^m_[a-z0-9_-]+$/).optional(),
  version: z.number().int().positive().optional(),
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
});

export const riskProfileSchema = z.object({
  level: riskLevelSchema,
  reasons: z.array(z.string())
});

export const missionSchema = z.object({
  id: z.string().regex(/^m_[a-z0-9_-]+$/),
  title: z.string().min(1),
  goal: z.string().min(1),
  successCriteria: z.array(z.string().min(1)).min(1),
  context: missionContextSchema,
  planGraph: missionPlanGraphSchema,
  state: missionStateSchema,
  riskProfile: riskProfileSchema,
  checkpoints: z.array(z.unknown()),
  approvals: z.array(z.unknown()),
  artifacts: z.array(z.unknown()),
  ledger: z.array(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type MissionState = z.infer<typeof missionStateSchema>;
export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type Mission = z.infer<typeof missionSchema>;

export interface CreateMissionInput {
  goal: string;
  title?: string;
  successCriteria?: string[];
}
