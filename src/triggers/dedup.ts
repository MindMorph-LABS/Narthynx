import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";
import type { TriggerDedupIndex } from "./schema";
import { MAX_DEDUP_ENTRIES, triggerDedupIndexSchema } from "./schema";
import { triggerDedupPath } from "./paths";

/** When over capacity, drop oldest entries by createdAt (ISO sort). */
async function pruneDedup(index: TriggerDedupIndex): Promise<TriggerDedupIndex> {
  const keys = Object.keys(index.entries);
  if (keys.length <= MAX_DEDUP_ENTRIES) {
    return index;
  }
  const sorted = keys.map((k) => ({ k, t: index.entries[k].createdAt })).sort((a, b) => a.t.localeCompare(b.t));
  const drop = sorted.length - MAX_DEDUP_ENTRIES;
  const next = { ...index, entries: { ...index.entries } };
  for (let i = 0; i < drop; i++) {
    delete next.entries[sorted[i].k];
  }
  return next;
}

export async function readDedupIndex(paths: WorkspacePaths): Promise<TriggerDedupIndex> {
  try {
    const raw = await readFile(triggerDedupPath(paths), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return triggerDedupIndexSchema.parse(parsed);
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String(e.code) : "";
    if (code === "ENOENT") {
      return { version: 1, entries: {} };
    }
    throw e;
  }
}

export async function recordDedup(
  paths: WorkspacePaths,
  dedupKey: string,
  missionId: string,
  ruleId: string,
  now: string
): Promise<void> {
  let index = await readDedupIndex(paths);
  index.entries[dedupKey] = { missionId, ruleId, createdAt: now };
  index = await pruneDedup(index);
  await mkdir(paths.workspaceDir, { recursive: true });
  await writeFile(triggerDedupPath(paths), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export async function removeDedupKey(paths: WorkspacePaths, dedupKey: string): Promise<void> {
  const index = await readDedupIndex(paths);
  if (!index.entries[dedupKey]) {
    return;
  }
  delete index.entries[dedupKey];
  await writeFile(triggerDedupPath(paths), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export function findDedupMission(index: TriggerDedupIndex, dedupKey: string): string | null {
  return index.entries[dedupKey]?.missionId ?? null;
}
