import { z } from "zod";

export const CONTEXT_PACKET_SCHEMA_VERSION = "narthynx.context.packet.v1" as const;

export const contextItemKindSchema = z.enum(["note", "file", "workspace_note", "memory"]);
export type ContextItemKind = z.infer<typeof contextItemKindSchema>;

export const contextTriggerSourceSchema = z.enum(["planning", "interactive", "cli", "manual"]);
export type ContextTriggerSource = z.infer<typeof contextTriggerSourceSchema>;

export const contextSensitivitySchema = z.enum(["none", "low", "sensitive"]);
export type ContextSensitivity = z.infer<typeof contextSensitivitySchema>;

export const contextPacketTriggerSchema = z.object({
  source: contextTriggerSourceSchema,
  planNodeId: z.string().optional()
});
export type ContextPacketTrigger = z.infer<typeof contextPacketTriggerSchema>;

export const contextItemSchema = z.object({
  id: z.string().min(1),
  kind: contextItemKindSchema,
  label: z.string(),
  /** Body text slated for pack (may be truncated). */
  text: z.string(),
  included: z.boolean(),
  /** Why this row was prioritized for inclusion when included. */
  reasonIncluded: z.string().optional(),
  /** Stable machine reason when omitted or zero-byte placeholder. */
  omitReason: z.string().optional(),
  sensitivity: contextSensitivitySchema,
  tokenEstimate: z.number().int().nonnegative(),
  originalBytes: z.number().int().nonnegative().optional(),
  includedBytes: z.number().int().nonnegative().optional(),
  compressionRatio: z.number().min(0).max(1).optional(),
  stale: z.boolean().optional(),
  /** Advisory only — router still enforces policy. */
  routingNote: z.enum(["eligible_for_cloud", "sensitive_prefs_local"]).optional(),
  memoryItemId: z.string().optional(),
  dedupeKey: z.string().optional(),
  /** Fingerprint of pre-compression/raw source for telemetry / dedupe. */
  contentSha256: z.string().length(64).optional(),
  /** How file-ish rows were sourced (telemetry). */
  sourceMode: z.enum(["full_file", "git_diff", "git_diff_fallback_full"]).optional()
});
export type ContextItem = z.infer<typeof contextItemSchema>;

export const excludedItemCategorySchema = z.enum([
  "policy_deny_path",
  "unreadable_file",
  "memory_policy_off",
  "git_diff_failed"
]);

export const excludedItemSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  category: excludedItemCategorySchema,
  detail: z.string().optional()
});
export type ExcludedItem = z.infer<typeof excludedItemSchema>;

export const cacheStatsSchema = z.object({
  /** Number of rows with contentSha256 present */
  fingerprints: z.number().int().nonnegative()
});
export type CacheStats = z.infer<typeof cacheStatsSchema>;

export const contextPacketTotalsSchema = z.object({
  bytes: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  noteCount: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  workspaceNoteCount: z.number().int().nonnegative(),
  memoryItemCount: z.number().int().nonnegative(),
  includedCount: z.number().int().nonnegative(),
  omittedCount: z.number().int().nonnegative(),
  staleOmittedCount: z.number().int().nonnegative(),
  exclusionCount: z.number().int().nonnegative().optional()
});
export type ContextPacketTotals = z.infer<typeof contextPacketTotalsSchema>;

export const contextPacketSchema = z.object({
  schema: z.literal(CONTEXT_PACKET_SCHEMA_VERSION),
  id: z.string(),
  missionId: z.string(),
  trigger: contextPacketTriggerSchema,
  createdAt: z.string().datetime(),
  items: z.array(contextItemSchema),
  totals: contextPacketTotalsSchema,
  excluded: z.array(excludedItemSchema),
  sensitiveContextIncluded: z.boolean(),
  packText: z.string(),
  cache: cacheStatsSchema.optional()
});
export type ContextPacket = z.infer<typeof contextPacketSchema>;
