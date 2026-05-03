import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspacePaths } from "../config/workspace";
import type { MemoryItemStored, MemoryProposalStored } from "./schema";
import { loadProposalRevisions, mergeLatestProposals } from "./proposals";
import { isMemoryItemVisible, mergeLatestMemoryItems, readAllMemoryRevisions, revokeMemoryItem } from "./store";

export interface MemoryExportBundle {
  exported_at: string;
  items: MemoryItemStored[];
  proposals: MemoryProposalStored[];
}

export async function exportMemoryWorkspace(paths: WorkspacePaths): Promise<string> {
  const mergedItems = mergeLatestMemoryItems(await readAllMemoryRevisions(paths));
  const activeItems = [...mergedItems.values()].filter(isMemoryItemVisible);
  const proposals = [...mergeLatestProposals(await loadProposalRevisions(paths)).values()];

  const bundle: MemoryExportBundle = {
    exported_at: new Date().toISOString(),
    items: activeItems,
    proposals
  };

  await mkdir(paths.memoryExportDir, { recursive: true });
  const safeStamp = bundle.exported_at.replaceAll(":", "-");
  const out = path.join(paths.memoryExportDir, `memory-export-${safeStamp}.json`);
  await writeFile(out, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return out;
}

export async function deleteActiveMemoryItem(paths: WorkspacePaths, id: string): Promise<boolean> {
  return revokeMemoryItem(paths, id);
}
