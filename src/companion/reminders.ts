import { readFile, writeFile } from "node:fs/promises";

import { z } from "zod";

import type { WorkspacePaths } from "../config/workspace";
import { createCompanionRowId } from "../utils/ids";
import { ensureCompanionDirs } from "./store";

export const companionReminderSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  fireAt: z.string(),
  message: z.string(),
  sessionId: z.string().optional(),
  status: z.enum(["pending", "delivered"])
});

export type CompanionReminder = z.infer<typeof companionReminderSchema>;

export function parseRemindFireAt(whenRaw: string, nowMs: number): { ok: true; fireAtIso: string } | { ok: false; reason: string } {
  const t = whenRaw.trim();
  if (!t) {
    return { ok: false, reason: "empty schedule" };
  }

  const rel = /^\+(\d+)\s*(m|min|minute|minutes)?$/i.exec(t);
  if (rel) {
    const minutes = Number(rel[1]);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10_080) {
      return { ok: false, reason: "relative minute window must be 1–10080" };
    }
    return { ok: true, fireAtIso: new Date(nowMs + minutes * 60_000).toISOString() };
  }

  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) {
    return { ok: false, reason: "expected ISO8601 datetime or +<minutes> relative offset" };
  }
  if (ms <= nowMs) {
    return { ok: false, reason: "fire time must be in the future" };
  }
  return { ok: true, fireAtIso: new Date(ms).toISOString() };
}

async function readAllReminders(paths: WorkspacePaths): Promise<CompanionReminder[]> {
  let raw = "";
  try {
    raw = await readFile(paths.companionRemindersFile, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const out: CompanionReminder[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const r = companionReminderSchema.safeParse(JSON.parse(line));
    if (r.success) {
      out.push(r.data);
    }
  }
  return out;
}

async function persistAll(paths: WorkspacePaths, rows: CompanionReminder[]): Promise<void> {
  await ensureCompanionDirs(paths);
  await writeFile(paths.companionRemindersFile, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
}

export async function appendCompanionReminder(paths: WorkspacePaths, input: Omit<CompanionReminder, "id" | "createdAt">): Promise<CompanionReminder> {
  await ensureCompanionDirs(paths);
  const row: CompanionReminder = companionReminderSchema.parse({
    id: createCompanionRowId("crm"),
    createdAt: new Date().toISOString(),
    ...input
  });
  const existing = await readAllReminders(paths);
  existing.push(row);
  await persistAll(paths, existing);
  return row;
}

/** Moves pending reminders with fireAt <= now to delivered status; returns the rows that fired (still pending snapshots). */
export async function peelDueCompanionReminders(paths: WorkspacePaths, nowMs: number): Promise<CompanionReminder[]> {
  const all = await readAllReminders(paths);
  const fired: CompanionReminder[] = [];
  const next: CompanionReminder[] = [];

  for (const r of all) {
    if (r.status !== "pending") {
      next.push(r);
      continue;
    }
    const at = Date.parse(r.fireAt);
    if (!Number.isFinite(at) || at > nowMs) {
      next.push(r);
      continue;
    }

    fired.push(r);
    next.push({
      ...r,
      status: "delivered"
    });
  }

  if (fired.length > 0) {
    await persistAll(paths, next);
  }
  return fired;
}

export async function listPendingCompanionReminders(paths: WorkspacePaths): Promise<CompanionReminder[]> {
  return (await readAllReminders(paths)).filter((r) => r.status === "pending");
}
