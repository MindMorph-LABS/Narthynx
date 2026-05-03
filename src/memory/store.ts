import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";
import type { WorkspacePolicy } from "../config/load";
import { createMemoryItemId } from "../utils/ids";
import type { MemoryItemStored } from "./schema";
import { MEMORY_ITEM_RECORD, memoryItemStoredSchema } from "./schema";
import { maybeMigrateFromCompanionLegacy } from "./migrate";

async function ensureMemoryDirs(paths: WorkspacePaths): Promise<void> {
  await mkdir(paths.memoryDir, { recursive: true });
  await mkdir(paths.memoryExportDir, { recursive: true });
}

export async function readAllMemoryRevisions(paths: WorkspacePaths): Promise<MemoryItemStored[]> {
  await maybeMigrateFromCompanionLegacy(paths);
  let raw = "";
  try {
    raw = await readFile(paths.memoryItemsFile, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const out: MemoryItemStored[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed: unknown = JSON.parse(line);
      const r = memoryItemStoredSchema.safeParse(parsed);
      if (r.success) {
        out.push(r.data);
      }
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

/** Latest revision per id wins (ISO timestamp lexical sort). */
export function mergeLatestMemoryItems(revisions: MemoryItemStored[]): Map<string, MemoryItemStored> {
  const sorted = [...revisions].sort((a, b) => {
    const c = a.updated_at.localeCompare(b.updated_at);
    return c !== 0 ? c : a.created_at.localeCompare(b.created_at);
  });
  const map = new Map<string, MemoryItemStored>();
  for (const rev of sorted) {
    map.set(rev.id, rev);
  }
  return map;
}

export function isMemoryItemVisible(item: MemoryItemStored): boolean {
  if (item.status !== "active") {
    return false;
  }
  if (item.expiry) {
    const t = Date.parse(item.expiry);
    if (Number.isFinite(t) && t <= Date.now()) {
      return false;
    }
  }
  return true;
}

export interface ListActiveMemoryOptions {
  scopes?: MemoryItemStored["scope"][];
  missionId?: string;
  /** Case-insensitive substring match on text/tags */
  query?: string;
  limit?: number;
}

export async function listActiveMemoryItems(paths: WorkspacePaths, options?: ListActiveMemoryOptions): Promise<MemoryItemStored[]> {
  const merged = mergeLatestMemoryItems(await readAllMemoryRevisions(paths));
  let rows = [...merged.values()].filter(isMemoryItemVisible);

  const scopesFilter = options?.scopes;
  if (scopesFilter && scopesFilter.length > 0) {
    const allowed = new Set(scopesFilter);
    rows = rows.filter((r) => allowed.has(r.scope));
  }
  const mid = options?.missionId?.trim();
  if (mid) {
    rows = rows.filter((r) => (r.scope !== "mission" ? true : r.mission_id === mid));
  }

  const q = options?.query?.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => {
      const inText = r.text.toLowerCase().includes(q);
      const inTags = r.tags.some((t) => t.toLowerCase().includes(q));
      return inText || inTags;
    });
  }

  rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const limit = options?.limit;
  if (limit !== undefined && limit >= 0) {
    rows = rows.slice(0, limit);
  }

  return rows;
}

/** Lineage ascending by updated_at then created_at */
export async function listMemoryRevisionLineage(paths: WorkspacePaths, id: string): Promise<MemoryItemStored[]> {
  const all = await readAllMemoryRevisions(paths);
  return all.filter((r) => r.id === id).sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.created_at.localeCompare(b.created_at));
}

export function allowedScopesForStorage(policyMemoryStorage: WorkspacePolicy["memory_storage"]): Set<MemoryItemStored["scope"]> {
  if (policyMemoryStorage === "off") {
    return new Set();
  }
  if (policyMemoryStorage === "minimal") {
    return new Set(["user", "relationship"]);
  }
  return new Set(["user", "relationship", "workspace", "mission", "procedural", "failure", "policy", "tool"]);
}

export function assertScopeAllowed(policy: WorkspacePolicy, scope: MemoryItemStored["scope"]): void {
  const ok = allowedScopesForStorage(policy.memory_storage).has(scope);
  if (!ok) {
    throw new Error(
      scopeAllowErrorMessage(policy.memory_storage, scope)
    );
  }
}

export function scopeAllowErrorMessage(storage: WorkspacePolicy["memory_storage"], scope: MemoryItemStored["scope"]): string {
  if (storage === "off") {
    return "Memory storage is disabled (policy memory_storage: off).";
  }
  if (storage === "minimal" && !["user", "relationship"].includes(scope)) {
    return `Scope "${scope}" requires policy memory_storage: balanced (current: minimal).`;
  }
  return `Scope "${scope}" is not allowed.`;
}

export interface AppendMemoryItemInput {
  id?: string;
  scope: MemoryItemStored["scope"];
  mission_id?: string;
  text: string;
  confidence?: number;
  sensitivity?: MemoryItemStored["sensitivity"];
  expiry?: string;
  tags?: string[];
  source: MemoryItemStored["source"];
  policy: WorkspacePolicy;
  /** When false, skip policy scope check (internal migration). */
  enforcePolicy?: boolean;
}

export async function appendMemoryItem(paths: WorkspacePaths, input: AppendMemoryItemInput): Promise<MemoryItemStored> {
  if (input.enforcePolicy !== false) {
    if (input.policy.memory_storage === "off") {
      throw new Error("Memory storage is disabled (policy memory_storage: off).");
    }
    assertScopeAllowed(input.policy, input.scope);
  }

  if (input.scope === "mission" && !input.mission_id) {
    throw new Error("mission_id is required when scope is mission.");
  }

  const now = new Date().toISOString();
  const id = input.id ?? createMemoryItemId();
  const existing = mergeLatestMemoryItems(await readAllMemoryRevisions(paths)).get(id);
  const created_at = existing?.created_at ?? now;

  const row: MemoryItemStored = memoryItemStoredSchema.parse({
    schema: MEMORY_ITEM_RECORD,
    id,
    created_at,
    updated_at: now,
    scope: input.scope,
    mission_id: input.mission_id,
    text: input.text.trim(),
    confidence: input.confidence ?? inferDefaultConfidence(input.source.kind),
    sensitivity: input.sensitivity ?? "none",
    status: "active",
    expiry: input.expiry,
    tags: input.tags ?? [],
    source: input.source
  });

  await ensureMemoryDirs(paths);
  await appendFile(paths.memoryItemsFile, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

function inferDefaultConfidence(kind: MemoryItemStored["source"]["kind"]): number {
  switch (kind) {
    case "user_cli":
    case "manual":
      return 1;
    case "companion_explicit":
      return 0.95;
    case "companion_model":
      return 0.55;
    case "migration_f17":
      return 0.9;
    case "tool_digest":
    case "mission_context":
      return 0.75;
    default:
      return 0.6;
  }
}

export async function revokeMemoryItem(paths: WorkspacePaths, id: string): Promise<boolean> {
  const merged = mergeLatestMemoryItems(await readAllMemoryRevisions(paths));
  const prev = merged.get(id);
  if (!prev || !isMemoryItemVisible(prev)) {
    return false;
  }
  const now = new Date().toISOString();
  const row: MemoryItemStored = memoryItemStoredSchema.parse({
    ...prev,
    updated_at: now,
    status: "revoked"
  });
  await ensureMemoryDirs(paths);
  await appendFile(paths.memoryItemsFile, `${JSON.stringify(row)}\n`, "utf8");
  return true;
}

export async function supersedeMemoryItem(paths: WorkspacePaths, id: string, newId: string): Promise<boolean> {
  const merged = mergeLatestMemoryItems(await readAllMemoryRevisions(paths));
  const prev = merged.get(id);
  if (!prev || !isMemoryItemVisible(prev)) {
    return false;
  }
  const now = new Date().toISOString();
  const tombstone: MemoryItemStored = memoryItemStoredSchema.parse({
    ...prev,
    updated_at: now,
    status: "superseded",
    superseded_by: newId
  });
  await ensureMemoryDirs(paths);
  await appendFile(paths.memoryItemsFile, `${JSON.stringify(tombstone)}\n`, "utf8");
  return true;
}
