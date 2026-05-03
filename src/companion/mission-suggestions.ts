import { writeFile } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";
import { createMissionStore } from "../missions/store";
import { appendMissionSuggestion, ensureCompanionDirs, readMissionSuggestions } from "./store";
import type { MissionSuggestion } from "./models";

export async function rewriteMissionSuggestions(paths: WorkspacePaths, rows: MissionSuggestion[]): Promise<void> {
  await ensureCompanionDirs(paths);
  await writeFile(paths.companionSuggestionsFile, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
}

export async function recordMissionSuggestionFromModel(
  paths: WorkspacePaths,
  input: { sessionId?: string; title: string; goal: string; summary?: string }
): Promise<{ id: string }> {
  const rec = await appendMissionSuggestion(paths, {
    sessionId: input.sessionId,
    summary: input.summary ?? input.title,
    proposedGoal: input.goal,
    proposedTitle: input.title,
    status: "proposed"
  });
  return { id: rec.id };
}

export async function acceptLatestProposedMissionSuggestion(
  paths: WorkspacePaths,
  cwd: string
): Promise<{ missionId: string; suggestionId: string } | { error: string }> {
  const suggestions = await readMissionSuggestions(paths);
  const candidate = [...suggestions].reverse().find((s) => s.status === "proposed");
  if (!candidate) {
    return { error: "No proposed companion mission suggestion found." };
  }
  const store = createMissionStore(cwd);
  const title = candidate.proposedTitle ?? candidate.summary;
  const mission = await store.createMission({ goal: candidate.proposedGoal, title });

  const next = suggestions.map((s) =>
    s.id === candidate.id ? { ...s, status: "accepted" as const, missionId: mission.id } : s
  );
  await rewriteMissionSuggestions(paths, next);
  return { missionId: mission.id, suggestionId: candidate.id };
}

export async function rejectLatestProposedMissionSuggestion(paths: WorkspacePaths): Promise<boolean> {
  const suggestions = await readMissionSuggestions(paths);
  const candidate = [...suggestions].reverse().find((s) => s.status === "proposed");
  if (!candidate) {
    return false;
  }
  const next = suggestions.map((s) => (s.id === candidate.id ? { ...s, status: "rejected" as const } : s));
  await rewriteMissionSuggestions(paths, next);
  return true;
}
