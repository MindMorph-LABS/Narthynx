import { z } from "zod";

export const companionMessageSchema = z.object({
  id: z.string(),
  ts: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  modelMeta: z.record(z.unknown()).optional()
});
export type CompanionMessage = z.infer<typeof companionMessageSchema>;

export const missionSuggestionStatusSchema = z.enum(["proposed", "accepted", "rejected"]);

export const missionSuggestionSchema = z.object({
  id: z.string(),
  ts: z.string(),
  sessionId: z.string().optional(),
  summary: z.string(),
  proposedGoal: z.string(),
  status: missionSuggestionStatusSchema,
  missionId: z.string().regex(/^m_[a-z0-9_-]+$/).optional(),
  proposedTitle: z.string().optional()
});
export type MissionSuggestion = z.infer<typeof missionSuggestionSchema>;

/** Model provider JSON envelope (Companion never executes tools — extra keys rejected). */
export const companionStructuredOutputSchema = z
  .object({
    reply: z.string(),
    suggestMission: z
      .object({
        title: z.string(),
        goal: z.string()
      })
      .optional(),
    proposeMemory: z.object({ text: z.string() }).optional()
  })
  .strict();
export type CompanionStructuredOutput = z.infer<typeof companionStructuredOutputSchema>;

export const companionMetaSchema = z.object({
  companion_host_mission_id: z.string().regex(/^m_[a-z0-9_-]+$/)
});

export type CompanionMeta = z.infer<typeof companionMetaSchema>;

export const personaFileSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(128),
  tone: z.string().min(1).max(2000),
  safety_appendix: z.string().max(4000).optional()
});
export type PersonaFile = z.infer<typeof personaFileSchema>;
