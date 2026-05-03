import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspacePaths } from "../config/workspace";
import { createCompanionRowId } from "../utils/ids";
import { companionMessageSchema, missionSuggestionSchema, type CompanionMessage, type MissionSuggestion } from "./models";

export function companionSessionMessagesPath(paths: WorkspacePaths, sessionId: string): string {
  return path.join(paths.companionSessionsDir, sessionId, "messages.jsonl");
}

export async function ensureCompanionDirs(paths: WorkspacePaths): Promise<void> {
  await mkdir(paths.companionDir, { recursive: true });
  await mkdir(paths.companionMemoryDir, { recursive: true });
  await mkdir(paths.companionArtifactsDir, { recursive: true });
  await mkdir(paths.companionSessionsDir, { recursive: true });
}

export async function appendCompanionMessage(
  paths: WorkspacePaths,
  sessionId: string,
  row: Omit<CompanionMessage, "id" | "ts"> & { id?: string; ts?: string }
): Promise<CompanionMessage> {
  await ensureCompanionDirs(paths);
  const dir = path.join(paths.companionSessionsDir, sessionId);
  await mkdir(dir, { recursive: true });
  const file = companionSessionMessagesPath(paths, sessionId);
  const msg: CompanionMessage = companionMessageSchema.parse({
    id: row.id ?? createCompanionRowId("cmsg"),
    ts: row.ts ?? new Date().toISOString(),
    role: row.role,
    text: row.text,
    modelMeta: row.modelMeta
  });
  await appendFile(file, `${JSON.stringify(msg)}\n`, "utf8");
  return msg;
}

export async function readCompanionMessages(
  paths: WorkspacePaths,
  sessionId: string,
  options?: { maxLines?: number }
): Promise<CompanionMessage[]> {
  const file = companionSessionMessagesPath(paths, sessionId);
  let raw = "";
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const slice = options?.maxLines ? lines.slice(-options.maxLines) : lines;
  const out: CompanionMessage[] = [];
  for (const line of slice) {
    try {
      out.push(companionMessageSchema.parse(JSON.parse(line)));
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

export async function appendMissionSuggestion(paths: WorkspacePaths, row: Omit<MissionSuggestion, "id" | "ts">): Promise<MissionSuggestion> {
  await ensureCompanionDirs(paths);
  const rec: MissionSuggestion = missionSuggestionSchema.parse({
    id: createCompanionRowId("csug"),
    ts: new Date().toISOString(),
    ...row
  });
  await appendFile(paths.companionSuggestionsFile, `${JSON.stringify(rec)}\n`, "utf8");
  return rec;
}

export async function readMissionSuggestions(paths: WorkspacePaths): Promise<MissionSuggestion[]> {
  let raw = "";
  try {
    raw = await readFile(paths.companionSuggestionsFile, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const out: MissionSuggestion[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      out.push(missionSuggestionSchema.parse(JSON.parse(line)));
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function findLatestProposedSuggestion(paths: WorkspacePaths): Promise<MissionSuggestion | undefined> {
  const all = await readMissionSuggestions(paths);
  const pending = all.filter((s) => s.status === "proposed").sort((a, b) => b.ts.localeCompare(a.ts));
  return pending[0];
}
