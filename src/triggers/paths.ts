import path from "node:path";

import type { WorkspacePaths } from "../config/workspace";

export const TRIGGER_EVENTS_FILE = "trigger-events.jsonl";
export const TRIGGERS_RULES_FILE = "triggers.yaml";
export const TRIGGER_DEDUP_FILE = "trigger-dedup.json";
export const TRIGGER_INBOX_DIR = "triggers/inbox";

export function triggerEventsPath(paths: WorkspacePaths): string {
  return path.join(paths.workspaceDir, TRIGGER_EVENTS_FILE);
}

export function triggersRulesPath(paths: WorkspacePaths): string {
  return path.join(paths.workspaceDir, TRIGGERS_RULES_FILE);
}

export function triggerDedupPath(paths: WorkspacePaths): string {
  return path.join(paths.workspaceDir, TRIGGER_DEDUP_FILE);
}

export function triggerInboxDir(paths: WorkspacePaths): string {
  return path.join(paths.workspaceDir, TRIGGER_INBOX_DIR);
}

export function triggerInboxFile(paths: WorkspacePaths, eventId: string): string {
  return path.join(triggerInboxDir(paths), `${eventId}.json`);
}
