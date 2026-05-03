import { appendFile, mkdir, readFile } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";
import { createMemoryConflictId } from "../utils/ids";
import type { MemoryConflictStored, MemoryItemStored } from "./schema";
import { MEMORY_CONFLICT_RECORD, memoryConflictStoredSchema } from "./schema";

function normalizeWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) {
      inter += 1;
    }
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface ConflictPair {
  a: MemoryItemStored;
  b: MemoryItemStored;
  similarity: number;
}

/** Overlapping-but-not-identical snippets in the same coarse bucket. */
export function detectMemoryConflicts(items: MemoryItemStored[], similarityThreshold = 0.82): ConflictPair[] {
  const pairs: ConflictPair[] = [];
  const byScope = new Map<string, MemoryItemStored[]>();
  for (const it of items) {
    const key = it.scope === "mission" ? `${it.scope}:${it.mission_id ?? ""}` : it.scope;
    const list = byScope.get(key) ?? [];
    list.push(it);
    byScope.set(key, list);
  }
  for (const group of byScope.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.id === b.id) {
          continue;
        }
        const sim = jaccard(normalizeWords(a.text), normalizeWords(b.text));
        if (sim >= similarityThreshold && a.text.trim().toLowerCase() !== b.text.trim().toLowerCase()) {
          pairs.push({ a, b, similarity: sim });
        }
      }
    }
  }
  return pairs;
}

async function readConflictRows(paths: WorkspacePaths): Promise<MemoryConflictStored[]> {
  let raw = "";
  try {
    raw = await readFile(paths.memoryConflictsFile, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const rows: MemoryConflictStored[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const r = memoryConflictStoredSchema.safeParse(JSON.parse(line));
    if (r.success) {
      rows.push(r.data);
    }
  }
  return rows;
}

function mergeLatestConflict(revisions: MemoryConflictStored[]): Map<string, MemoryConflictStored> {
  const sorted = [...revisions].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  const map = new Map<string, MemoryConflictStored>();
  for (const r of sorted) {
    map.set(r.id, r);
  }
  return map;
}

export async function listOpenMemoryConflicts(paths: WorkspacePaths): Promise<MemoryConflictStored[]> {
  return [...mergeLatestConflict(await readConflictRows(paths)).values()].filter((c) => c.status === "open");
}

export async function recordMemoryConflict(
  paths: WorkspacePaths,
  input: Omit<ConflictPair, "similarity"> & { similarity: number; notes?: string }
): Promise<string> {
  const now = new Date().toISOString();
  const id = createMemoryConflictId();
  const row = memoryConflictStoredSchema.parse({
    schema: MEMORY_CONFLICT_RECORD,
    id,
    created_at: now,
    updated_at: now,
    item_ids: [input.a.id, input.b.id],
    reason: `High similarity (${input.similarity.toFixed(2)}) in scope bucket ${input.a.scope}`,
    status: "open",
    resolution_note: input.notes
  });
  await mkdir(paths.memoryDir, { recursive: true });
  await appendFile(paths.memoryConflictsFile, `${JSON.stringify(row)}\n`, "utf8");
  return id;
}
