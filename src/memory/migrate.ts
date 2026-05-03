import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

import { z } from "zod";

import type { WorkspacePaths } from "../config/workspace";
import {
  MEMORY_ITEM_RECORD,
  MEMORY_PROPOSAL_RECORD,
  memoryItemStoredSchema,
  memoryProposalStoredSchema
} from "./schema";

const legacyApprovedSchema = z.object({
  id: z.string(),
  ts: z.string(),
  text: z.string()
});

const legacyPendingSchema = z.object({
  id: z.string(),
  ts: z.string(),
  text: z.string(),
  sessionId: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected"])
});

async function companionFileReadable(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function ensureMemoryRoot(paths: WorkspacePaths): Promise<void> {
  await mkdir(paths.memoryDir, { recursive: true });
}

/**
 * One-time import from F17 `.narthynx/companion/memory/*.jsonl` into `.narthynx/memory/` (Frontier F18).
 */
export async function maybeMigrateFromCompanionLegacy(paths: WorkspacePaths): Promise<void> {
  try {
    await readFile(paths.memoryMigratedFlagFile, "utf8");
    return;
  } catch {
    /* not migrated yet */
  }

  await ensureMemoryRoot(paths);

  const existingItemIds = await collectJsonIds(paths.memoryItemsFile);
  const existingProposalIds = await collectJsonIds(paths.memoryProposalsFile);

  const hasCompanionApproved = await companionFileReadable(paths.companionApprovedMemoryFile);
  const hasCompanionPending = await companionFileReadable(paths.companionPendingMemoryFile);
  if (!hasCompanionApproved && !hasCompanionPending) {
    await writeMigrationFlag(paths, "nothing_to_migrate");
    return;
  }

  if (hasCompanionApproved) {
    try {
      const raw = await readFile(paths.companionApprovedMemoryFile, "utf8");
      for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        try {
          const parsed: unknown = JSON.parse(line);
          const r = legacyApprovedSchema.safeParse(parsed);
          if (!r.success) {
            continue;
          }
          const row = memoryItemStoredSchema.parse({
            schema: MEMORY_ITEM_RECORD,
            id: r.data.id,
            created_at: r.data.ts,
            updated_at: r.data.ts,
            scope: "user",
            text: r.data.text,
            confidence: 0.9,
            sensitivity: "none",
            status: "active",
            tags: [],
            source: { kind: "migration_f17", citation: "companion/memory/approved.jsonl" }
          });
          if (existingItemIds.has(row.id)) {
            continue;
          }
          existingItemIds.add(row.id);
          await appendFile(paths.memoryItemsFile, `${JSON.stringify(row)}\n`, "utf8");
        } catch {
          /* skip line */
        }
      }
    } catch {
      /* skip import */
    }
  }

  if (hasCompanionPending) {
    try {
      const raw = await readFile(paths.companionPendingMemoryFile, "utf8");
      for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        try {
          const parsed: unknown = JSON.parse(line);
          const r = legacyPendingSchema.safeParse(parsed);
          if (!r.success || r.data.status !== "pending") {
            continue;
          }
          if (existingProposalIds.has(r.data.id)) {
            continue;
          }
          existingProposalIds.add(r.data.id);
          const row = memoryProposalStoredSchema.parse({
            schema: MEMORY_PROPOSAL_RECORD,
            id: r.data.id,
            created_at: r.data.ts,
            updated_at: r.data.ts,
            scope: "relationship",
            text: r.data.text,
            sensitivity: "none",
            status: "pending",
            source: {
              kind: "companion_explicit",
              companion_session_id: r.data.sessionId,
              citation: "companion/memory/pending.jsonl"
            }
          });
          await appendFile(paths.memoryProposalsFile, `${JSON.stringify(row)}\n`, "utf8");
        } catch {
          /* skip line */
        }
      }
    } catch {
      /* skip import */
    }
  }

  await writeMigrationFlag(paths, "companion_memory_jsonl_imported");
}

async function writeMigrationFlag(paths: WorkspacePaths, note: string): Promise<void> {
  await ensureMemoryRoot(paths);
  await writeFile(
    paths.memoryMigratedFlagFile,
    `${JSON.stringify({ migrated_at: new Date().toISOString(), note }, null, 2)}\n`,
    "utf8"
  );
}

async function collectJsonIds(path: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return ids;
  }
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "id" in parsed && typeof (parsed as { id: unknown }).id === "string") {
        ids.add((parsed as { id: string }).id);
      }
    } catch {
      /* skip */
    }
  }
  return ids;
}
