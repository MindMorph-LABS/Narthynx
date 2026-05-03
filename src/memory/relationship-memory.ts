import { appendFile, readFile, writeFile } from "node:fs/promises";

import { z } from "zod";

import type { WorkspacePaths } from "../config/workspace";
import { createCompanionRowId } from "../utils/ids";
import { appendApprovedMemory } from "./user-memory";
import { ensureCompanionDirs } from "../companion/store";

const pendingMemorySchema = z.object({
  id: z.string(),
  ts: z.string(),
  text: z.string(),
  sessionId: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected"])
});
export type PendingMemoryProposal = z.infer<typeof pendingMemorySchema>;

async function readPendingFile(paths: WorkspacePaths): Promise<PendingMemoryProposal[]> {
  let raw = "";
  try {
    raw = await readFile(paths.companionPendingMemoryFile, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const out: PendingMemoryProposal[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const r = pendingMemorySchema.safeParse(JSON.parse(line));
      if (r.success) {
        out.push(r.data);
      }
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

async function persistPending(paths: WorkspacePaths, rows: PendingMemoryProposal[]): Promise<void> {
  await writeFile(paths.companionPendingMemoryFile, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
}

export async function listPendingMemoryProposals(paths: WorkspacePaths): Promise<PendingMemoryProposal[]> {
  return (await readPendingFile(paths)).filter((r) => r.status === "pending");
}

export async function appendPendingMemoryProposal(paths: WorkspacePaths, text: string, sessionId?: string): Promise<PendingMemoryProposal> {
  await ensureCompanionDirs(paths);
  const row: PendingMemoryProposal = pendingMemorySchema.parse({
    id: createCompanionRowId("cpend"),
    ts: new Date().toISOString(),
    text: text.trim(),
    sessionId,
    status: "pending"
  });
  await appendFile(paths.companionPendingMemoryFile, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

export async function approvePendingMemoryProposal(paths: WorkspacePaths, id: string): Promise<boolean> {
  const rows = await readPendingFile(paths);
  const idx = rows.findIndex((r) => r.id === id && r.status === "pending");
  if (idx < 0) {
    return false;
  }
  const match = rows[idx]!;
  await appendApprovedMemory(paths, match.text);
  rows[idx] = { ...match, status: "approved" };
  await persistPending(paths, rows);
  return true;
}

export async function rejectPendingMemoryProposal(paths: WorkspacePaths, id: string): Promise<boolean> {
  const rows = await readPendingFile(paths);
  const idx = rows.findIndex((r) => r.id === id && r.status === "pending");
  if (idx < 0) {
    return false;
  }
  rows[idx] = { ...rows[idx]!, status: "rejected" };
  await persistPending(paths, rows);
  return true;
}
