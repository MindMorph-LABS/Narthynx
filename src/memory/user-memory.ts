import { appendFile, readFile, writeFile } from "node:fs/promises";

import { z } from "zod";

import type { WorkspacePaths } from "../config/workspace";
import { createCompanionRowId } from "../utils/ids";
import { ensureCompanionDirs } from "../companion/store";

const approvedMemorySchema = z.object({
  id: z.string(),
  ts: z.string(),
  text: z.string()
});
export type ApprovedMemoryEntry = z.infer<typeof approvedMemorySchema>;

export async function listApprovedMemory(paths: WorkspacePaths): Promise<ApprovedMemoryEntry[]> {
  let raw = "";
  try {
    raw = await readFile(paths.companionApprovedMemoryFile, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const out: ApprovedMemoryEntry[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const r = approvedMemorySchema.safeParse(JSON.parse(line));
      if (r.success) {
        out.push(r.data);
      }
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

export async function appendApprovedMemory(paths: WorkspacePaths, text: string): Promise<ApprovedMemoryEntry> {
  await ensureCompanionDirs(paths);
  const row: ApprovedMemoryEntry = {
    id: createCompanionRowId("cmem"),
    ts: new Date().toISOString(),
    text: text.trim()
  };
  approvedMemorySchema.parse(row);
  await appendFile(paths.companionApprovedMemoryFile, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

export async function deleteApprovedMemoryById(paths: WorkspacePaths, id: string): Promise<boolean> {
  const rows = await listApprovedMemory(paths);
  const next = rows.filter((r) => r.id !== id);
  if (next.length === rows.length) {
    return false;
  }
  await writeFile(paths.companionApprovedMemoryFile, `${next.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  return true;
}

export async function approvedMemorySnippetForModel(paths: WorkspacePaths, options?: { maxChars?: number }): Promise<string> {
  const max = options?.maxChars ?? 2_048;
  const rows = await listApprovedMemory(paths);
  const parts: string[] = [];
  let used = 0;
  for (const r of rows) {
    const chunk = `- ${r.text}`;
    if (used + chunk.length > max) {
      break;
    }
    parts.push(chunk);
    used += chunk.length + 1;
  }
  return parts.join("\n");
}
