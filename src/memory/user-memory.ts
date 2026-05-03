import { z } from "zod";

import { loadWorkspacePolicy } from "../config/load";
import type { WorkspacePaths } from "../config/workspace";
import { appendMemoryItem, listActiveMemoryItems, revokeMemoryItem } from "./store";
import type { MemoryItemStored } from "./schema";

export const approvedMemorySchema = z.object({
  id: z.string(),
  ts: z.string(),
  text: z.string()
});
export type ApprovedMemoryEntry = z.infer<typeof approvedMemorySchema>;

function toApprovedEntry(row: MemoryItemStored): ApprovedMemoryEntry {
  return { id: row.id, ts: row.updated_at, text: row.text };
}

/** Active items in scopes traditionally shown as “approved companion memory” (F17 shim → F18 store). */
export async function listApprovedMemory(paths: WorkspacePaths): Promise<ApprovedMemoryEntry[]> {
  const rows = await listActiveMemoryItems(paths, { scopes: ["user", "relationship"] });
  return rows.map(toApprovedEntry);
}

export async function appendApprovedMemory(paths: WorkspacePaths, text: string): Promise<ApprovedMemoryEntry> {
  const policy = await loadWorkspacePolicy(paths.policyFile);
  if (!policy.ok) {
    throw new Error(`policy.yaml invalid: ${policy.message}`);
  }
  const row = await appendMemoryItem(paths, {
    scope: "user",
    text,
    source: { kind: "user_cli", citation: "user-memory.appendApprovedMemory" },
    policy: policy.value
  });
  return toApprovedEntry(row);
}

export async function deleteApprovedMemoryById(paths: WorkspacePaths, id: string): Promise<boolean> {
  return revokeMemoryItem(paths, id);
}

export { approvedMemorySnippetForModel } from "./retrieval";
