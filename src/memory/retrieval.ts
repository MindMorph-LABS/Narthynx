import type { WorkspacePaths } from "../config/workspace";
import type { WorkspacePolicy } from "../config/load";
import { loadWorkspacePolicy } from "../config/load";
import type { MemoryItemStored } from "./schema";
import { listActiveMemoryItems } from "./store";

function mergeById(items: MemoryItemStored[]): MemoryItemStored[] {
  const m = new Map<string, MemoryItemStored>();
  for (const row of items) {
    const prev = m.get(row.id);
    if (!prev || row.updated_at.localeCompare(prev.updated_at) >= 0) {
      m.set(row.id, row);
    }
  }
  return [...m.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** Items surfaced into mission planner context packs (policy + scope aware). */
export async function listMemoryItemsForMissionContext(
  paths: WorkspacePaths,
  missionId: string,
  policy: WorkspacePolicy
): Promise<MemoryItemStored[]> {
  if (policy.memory_storage === "off") {
    return [];
  }

  const globals = await listActiveMemoryItems(paths, { scopes: ["user", "relationship"] });
  if (policy.memory_storage === "minimal") {
    return mergeById([...globals]);
  }

  const workspaceRows = await listActiveMemoryItems(paths, { scopes: ["workspace"] });
  const missionRows = await listActiveMemoryItems(paths, { scopes: ["mission"], missionId });
  const extra = await listActiveMemoryItems(paths, { scopes: ["procedural", "failure", "policy", "tool"] });
  return mergeById([...globals, ...workspaceRows, ...missionRows, ...extra]);
}

export function formatMemoryLineForPack(item: MemoryItemStored, citationsRequired: boolean): string {
  if (citationsRequired) {
    return `[memory:${item.id}] ${item.text}`;
  }
  return item.text;
}

export async function approvedMemorySnippetForModel(paths: WorkspacePaths, options?: { maxChars?: number }): Promise<string> {
  const max = options?.maxChars ?? 2_048;
  const policyResult = await loadWorkspacePolicy(paths.policyFile);
  if (!policyResult.ok || policyResult.value.memory_storage === "off") {
    return "";
  }
  const citationsRequired = policyResult.value.memory_mission_citations_required;
  const rows = await listActiveMemoryItems(paths, { scopes: ["user", "relationship"] });
  let used = 0;
  const parts: string[] = [];
  for (const r of rows) {
    const line = `- ${formatMemoryLineForPack(r, citationsRequired)}`;
    if (used + line.length > max) {
      break;
    }
    parts.push(line);
    used += line.length + 1;
  }
  return parts.join("\n");
}
