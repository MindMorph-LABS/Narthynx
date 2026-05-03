import { z } from "zod";

export const triggerSourceSchema = z.enum(["github", "manual", "generic"]);

export const triggerOutcomeSchema = z.enum(["matched", "no_match", "dedup_skip", "error", "dry_run"]);

export const triggerRuleMatchSchema = z.object({
  event: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  /** If set, `repository.full_name` (from context) must include this substring. */
  repository: z.string().min(1).optional()
});

export const triggerRuleActionSchema = z
  .object({
    type: z.literal("create_mission"),
    template: z.string().min(1).optional(),
    goalTemplate: z.string().min(1).optional(),
    titleTemplate: z.string().min(1).optional(),
    appendContextNotes: z.array(z.string().min(1)).optional()
  })
  .refine((a) => Boolean(a.template) || Boolean(a.goalTemplate), {
    message: "action requires template or goalTemplate"
  });

export const triggerRuleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().optional(),
  source: triggerSourceSchema,
  match: triggerRuleMatchSchema,
  action: triggerRuleActionSchema,
  dedupKeyFrom: z.array(z.string().min(1)).min(1)
});

export const triggersFileSchema = z.object({
  version: z.literal(1),
  rules: z.array(triggerRuleSchema)
});

export type TriggersConfig = z.infer<typeof triggersFileSchema>;
export type TriggerRule = z.infer<typeof triggerRuleSchema>;

export const triggerLogLineSchema = z.object({
  eventId: z.string().min(1),
  receivedAt: z.string().datetime(),
  source: z.string(),
  outcome: triggerOutcomeSchema,
  ruleId: z.string().optional(),
  missionId: z.string().optional(),
  dedupKey: z.string(),
  message: z.string().optional(),
  payloadSha256: z.string().optional(),
  payloadRef: z.string().optional(),
  /** GitHub `X-GitHub-Event` for replay matching. */
  githubEventName: z.string().optional()
});

export type TriggerLogLine = z.infer<typeof triggerLogLineSchema>;

export const triggerDedupIndexSchema = z.object({
  version: z.literal(1),
  entries: z.record(
    z.string(),
    z.object({
      missionId: z.string(),
      ruleId: z.string(),
      createdAt: z.string().datetime()
    })
  )
});

export type TriggerDedupIndex = z.infer<typeof triggerDedupIndexSchema>;

export const MAX_DEDUP_ENTRIES = 2000;
