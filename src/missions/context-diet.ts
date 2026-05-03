import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { isSensitiveContextPath } from "../cli/shortcuts";
import { workspaceNoteLooksSensitive } from "../cli/workspace-notes";
import { truncateFileForPack } from "../context/compression";
import { compileContextPacket } from "../context/kernel";
import type { ContextPacket, ContextPacketTrigger } from "../context/types";
import { loadWorkspacePolicy, type WorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { resolveGuardedWorkspacePath } from "../tools/path-guard";
import { readMissionContextIndex, sha256Utf8, writeMissionContextIndex } from "./context";
import { createMissionStore, missionDirectory, missionFilePath } from "./store";

export { truncateFileForPack } from "../context/compression";

export type ModelContextPackEntryKind = "note" | "file" | "workspace_note" | "memory";

export interface ModelContextPackEntry {
  kind: ModelContextPackEntryKind;
  label: string;
  text: string;
  estimatedTokens: number;
  omittedReason?: string;
  stale?: boolean;
  includedOnce?: boolean;
  /** Present when kind === "memory" — used for citations in ledgers. */
  memoryItemId?: string;
  memorySensitivity?: "none" | "low" | "sensitive";
}

export interface ModelContextPackTotals {
  bytes: number;
  estimatedTokens: number;
  noteCount: number;
  fileCount: number;
  workspaceNoteCount: number;
  memoryItemCount: number;
  includedCount: number;
  omittedCount: number;
  staleOmittedCount: number;
}

export interface ModelContextPack {
  entries: ModelContextPackEntry[];
  totals: ModelContextPackTotals;
  sensitiveContextIncluded: boolean;
  packText: string;
  /** Present when compiled via the Phase 19 context kernel (ledger + artifacts). */
  contextPacketId?: string;
  /** Counts by `ExcludedItem.category` from the compilation pass. */
  exclusionCounts?: Record<string, number>;
}

export interface BuildModelContextPackOptions {
  recordLedger?: boolean;
  trigger?: ContextPacketTrigger;
}

function contextPacketToModelPack(packet: ContextPacket): ModelContextPack {
  const entries: ModelContextPackEntry[] = packet.items.map((i) => ({
    kind: i.kind as ModelContextPackEntryKind,
    label: i.label,
    text: i.text,
    estimatedTokens: i.tokenEstimate,
    omittedReason: i.omitReason,
    stale: i.stale,
    includedOnce: i.included && i.text.length > 0 ? true : undefined,
    memoryItemId: i.memoryItemId,
    memorySensitivity: i.kind === "memory" ? i.sensitivity : undefined
  }));

  const sensitiveContextIncluded = packet.items.some((e) => {
    if (!e.text) {
      return false;
    }
    if (workspaceNoteLooksSensitive(e.text)) {
      return true;
    }
    if (e.kind === "memory" && e.sensitivity === "sensitive") {
      return true;
    }
    if ((e.kind === "file" || e.kind === "workspace_note") && isSensitiveContextPath(e.label)) {
      return true;
    }
    return false;
  });

  const { exclusionCount: _e, ...totals } = packet.totals;
  const exclusionCounts = packet.excluded.reduce<Record<string, number>>((acc, ex) => {
    acc[ex.category] = (acc[ex.category] ?? 0) + 1;
    return acc;
  }, {});

  return {
    entries,
    totals,
    sensitiveContextIncluded,
    packText: packet.packText,
    contextPacketId: packet.id,
    exclusionCounts: Object.keys(exclusionCounts).length > 0 ? exclusionCounts : undefined
  };
}

export async function buildModelContextPack(
  missionId: string,
  cwd = process.cwd(),
  options: BuildModelContextPackOptions = {}
): Promise<ModelContextPack> {
  const recordLedger = options.recordLedger !== false;
  const trigger: ContextPacketTrigger = options.trigger ?? { source: "manual" };
  const { packet } = await compileContextPacket({
    cwd,
    missionId,
    trigger,
    persist: recordLedger
  });
  return contextPacketToModelPack(packet);
}

export interface StaleContextEntryInfo {
  source: string;
  type: "note" | "file";
  stale: boolean;
  addedAt: string;
}

export async function listStaleContextEntries(missionId: string, cwd = process.cwd()): Promise<StaleContextEntryInfo[]> {
  const paths = resolveWorkspacePaths(cwd);
  const policy = await loadWorkspacePolicy(paths.policyFile);
  if (!policy.ok) {
    throw new Error(`policy.yaml invalid: ${policy.message}`);
  }
  const index = await readMissionContextIndex(cwd, missionId);
  const missionStore = createMissionStore(cwd);
  const mission = await missionStore.readMission(missionId);
  let noteCursor = 0;
  const out: StaleContextEntryInfo[] = [];

  for (const entry of index.entries) {
    if (entry.type === "note") {
      const text = mission.context.notes[noteCursor];
      noteCursor += 1;
      if (entry.duplicateOf) {
        continue;
      }
      const st =
        text !== undefined && entry.contentSha256 !== undefined && sha256Utf8(text) !== entry.contentSha256;
      out.push({
        source: `note@${entry.addedAt}`,
        type: "note",
        stale: Boolean(st),
        addedAt: entry.addedAt
      });
    } else if (!entry.duplicateOf) {
      const guarded = resolveGuardedWorkspacePath(cwd, entry.source, policy.value);
      try {
        const st = await stat(guarded.absolutePath);
        if (!st.isFile()) {
          out.push({ source: entry.source, type: "file", stale: true, addedAt: entry.addedAt });
          continue;
        }
        const content = await readFile(guarded.absolutePath, "utf8");
        const diskHash = sha256Utf8(content);
        const diskMtime = Math.trunc(st.mtimeMs);
        let stale = false;
        if (entry.contentSha256 && entry.contentSha256 !== diskHash) {
          stale = true;
        }
        if (entry.sourceMtimeMs !== undefined && diskMtime !== entry.sourceMtimeMs && !entry.contentSha256) {
          stale = true;
        }
        out.push({ source: entry.source, type: "file", stale, addedAt: entry.addedAt });
      } catch {
        out.push({ source: entry.source, type: "file", stale: true, addedAt: entry.addedAt });
      }
    }
  }

  return out;
}

export async function pruneStaleContextEntries(missionId: string, cwd = process.cwd()): Promise<number> {
  const paths = resolveWorkspacePaths(cwd);
  const index = await readMissionContextIndex(cwd, missionId);
  const staleRows = await listStaleContextEntries(missionId, cwd);
  const staleFileSources = new Set(
    staleRows.filter((r) => r.stale && r.type === "file").map((r) => r.source)
  );

  const nextEntries = index.entries.filter((e) => {
    if (e.type === "file" && staleFileSources.has(e.source)) {
      return false;
    }
    if (e.type === "file" && e.duplicateOf && staleFileSources.has(e.duplicateOf)) {
      return false;
    }
    return true;
  });

  const missionStore = createMissionStore(cwd);
  const mission = await missionStore.readMission(missionId);
  const removed = index.entries.length - nextEntries.length;
  if (removed === 0) {
    return 0;
  }

  await writeMissionContextIndex(cwd, { missionId, entries: nextEntries });

  const updatedMission = {
    ...mission,
    context: {
      ...mission.context,
      files: mission.context.files.filter((f) => !staleFileSources.has(f))
    },
    updatedAt: new Date().toISOString()
  };
  await writeFile(missionFilePath(paths.missionsDir, missionId), YAML.stringify(updatedMission), "utf8");

  return removed;
}
