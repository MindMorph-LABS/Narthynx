import { z } from "zod";

export const MEMORY_ITEM_RECORD = "narthynx.memory.item.v1" as const;
export const MEMORY_PROPOSAL_RECORD = "narthynx.memory.proposal.v1" as const;
export const MEMORY_CONFLICT_RECORD = "narthynx.memory.conflict.v1" as const;

export const memoryScopeSchema = z.enum([
  "user",
  "relationship",
  "workspace",
  "mission",
  "procedural",
  "failure",
  "policy",
  "tool"
]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memorySourceKindSchema = z.enum([
  "user_cli",
  "companion_explicit",
  "companion_model",
  "mission_context",
  "migration_f17",
  "tool_digest",
  "manual",
  "scheduled"
]);
export type MemorySourceKind = z.infer<typeof memorySourceKindSchema>;

export const memorySensitivitySchema = z.enum(["none", "low", "sensitive"]);
export type MemorySensitivity = z.infer<typeof memorySensitivitySchema>;

export const memoryItemStatusSchema = z.enum(["active", "revoked", "superseded"]);
export type MemoryItemStatus = z.infer<typeof memoryItemStatusSchema>;

export const memorySourceSchema = z.object({
  kind: memorySourceKindSchema,
  companion_session_id: z.string().optional(),
  /** Human-readable provenance: path, mission id, ledger ref, etc. */
  citation: z.string().optional()
});
export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memoryItemStoredSchema = z.object({
  schema: z.literal(MEMORY_ITEM_RECORD),
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  scope: memoryScopeSchema,
  /** Required when scope === "mission". */
  mission_id: z.string().regex(/^m_[a-z0-9_-]+$/).optional(),
  text: z.string().min(1).max(32_000),
  confidence: z.number().min(0).max(1),
  sensitivity: memorySensitivitySchema,
  status: memoryItemStatusSchema,
  expiry: z.string().optional(),
  tags: z.array(z.string()).default([]),
  source: memorySourceSchema,
  superseded_by: z.string().optional()
});
export type MemoryItemStored = z.infer<typeof memoryItemStoredSchema>;

export const memoryProposalStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type MemoryProposalStatus = z.infer<typeof memoryProposalStatusSchema>;

export const memoryProposalStoredSchema = z.object({
  schema: z.literal(MEMORY_PROPOSAL_RECORD),
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  scope: memoryScopeSchema,
  mission_id: z.string().regex(/^m_[a-z0-9_-]+$/).optional(),
  text: z.string().min(1).max(32_000),
  sensitivity: memorySensitivitySchema,
  status: memoryProposalStatusSchema,
  source: memorySourceSchema
});
export type MemoryProposalStored = z.infer<typeof memoryProposalStoredSchema>;

export const memoryConflictStatusSchema = z.enum(["open", "resolved"]);
export type MemoryConflictStatus = z.infer<typeof memoryConflictStatusSchema>;

export const memoryConflictStoredSchema = z.object({
  schema: z.literal(MEMORY_CONFLICT_RECORD),
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Item ids involved */
  item_ids: z.array(z.string()).min(2).max(24),
  reason: z.string().min(1).max(2048),
  status: memoryConflictStatusSchema,
  resolution_note: z.string().max(4000).optional()
});
export type MemoryConflictStored = z.infer<typeof memoryConflictStoredSchema>;

/** Active item after merge (latest revision wins). */
export interface MemoryItemActive extends MemoryItemStored {
  status: "active";
}
