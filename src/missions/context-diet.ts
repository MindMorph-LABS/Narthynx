import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { isSensitiveContextPath } from "../cli/shortcuts";
import { workspaceNoteLooksSensitive } from "../cli/workspace-notes";
import { loadContextDietConfig, type ContextDietConfig } from "../config/context-diet-config";
import { loadWorkspacePolicy, type WorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { formatMemoryLineForPack, listMemoryItemsForMissionContext } from "../memory/retrieval";
import { resolveGuardedWorkspacePath } from "../tools/path-guard";
import { readMissionContextIndex, sha256Utf8, writeMissionContextIndex, type ContextEntry } from "./context";
import { appendLedgerEvent, ledgerFilePath } from "./ledger";
import { createMissionStore, missionDirectory, missionFilePath } from "./store";

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
}

export interface BuildModelContextPackOptions {
  recordLedger?: boolean;
}

interface ResolvedItem {
  kind: ModelContextPackEntryKind;
  label: string;
  fullText: string;
  packBytes: number;
  stale: boolean;
  sortWeight: number;
  /** Hash key for pack-time dedup */
  dedupeKey: string;
  memoryItemId?: string;
  memorySensitivity?: "none" | "low" | "sensitive";
}

const WORKSPACE_NOTES_FILE = "workspace-notes.md";

export async function buildModelContextPack(
  missionId: string,
  cwd = process.cwd(),
  options: BuildModelContextPackOptions = {}
): Promise<ModelContextPack> {
  const paths = resolveWorkspacePaths(cwd);
  const recordLedger = options.recordLedger !== false;
  const dietResult = await loadContextDietConfig(paths.contextDietFile);
  if (!dietResult.ok) {
    throw new Error(`context-diet.yaml invalid: ${dietResult.message}`);
  }
  const diet = dietResult.value;

  const policy = await loadWorkspacePolicy(paths.policyFile);
  if (!policy.ok) {
    throw new Error(`policy.yaml invalid: ${policy.message}`);
  }

  const index = await readMissionContextIndex(cwd, missionId);
  const missionStore = createMissionStore(cwd);
  const mission = await missionStore.readMission(missionId);
  let noteCursor = 0;

  const resolved: ResolvedItem[] = [];

  for (const entry of index.entries) {
    if (entry.type === "note") {
      const text = mission.context.notes[noteCursor];
      noteCursor += 1;
      if (entry.duplicateOf) {
        continue;
      }
      if (text === undefined) {
        continue;
      }
      const bytes = Buffer.byteLength(text, "utf8");
      const hash = entry.contentSha256 ?? sha256Utf8(text);
      resolved.push({
        kind: "note",
        label: `note@${entry.addedAt}`,
        fullText: text,
        packBytes: bytes,
        stale: false,
        sortWeight: 0,
        dedupeKey: `h:${hash}`
      });
    } else if (!entry.duplicateOf) {
      const fileItem = await resolveFileEntryForPack(entry, cwd, policy.value, diet);
      if (fileItem) {
        resolved.push(fileItem);
      }
    }
  }

  if (diet.include_workspace_notes) {
    const ws = await readWorkspaceNotesPackSlice(paths.workspaceDir, diet);
    if (ws) {
      resolved.push(ws);
    }
  }

  if (policy.value.memory_storage !== "off") {
    const memRows = await listMemoryItemsForMissionContext(paths, missionId, policy.value);
    const cite = policy.value.memory_mission_citations_required;
    for (const item of memRows) {
      const truncatedText = truncateFileForPack(item.text, diet);
      const line = formatMemoryLineForPack({ ...item, text: truncatedText }, cite);
      const packBytes = Buffer.byteLength(line, "utf8");
      resolved.push({
        kind: "memory",
        label: cite ? `memory@${item.id}` : "memory",
        fullText: line,
        packBytes,
        stale: false,
        sortWeight: 62,
        dedupeKey: `mem:${item.id}`,
        memoryItemId: item.id,
        memorySensitivity: item.sensitivity
      });
    }
  }

  resolved.sort((a, b) => a.sortWeight - b.sortWeight);

  const seen = new Set<string>();
  const candidates: ResolvedItem[] = [];
  for (const item of resolved) {
    if (seen.has(item.dedupeKey)) {
      continue;
    }
    seen.add(item.dedupeKey);
    candidates.push(item);
  }

  const maxBytes = diet.pack_max_bytes;
  const maxTok = diet.pack_max_estimated_tokens;

  const included: ModelContextPackEntry[] = [];
  let runningBytes = 0;
  let runningTok = 0;
  let omittedCount = 0;
  let staleOmitted = 0;

  for (const item of candidates) {
    if (item.stale && diet.stale_policy === "omit_from_pack") {
      included.push({
        kind: item.kind,
        label: item.label,
        text: "",
        estimatedTokens: 0,
        omittedReason: "stale_file_omitted",
        stale: true,
        memoryItemId: item.memoryItemId,
        memorySensitivity: item.memorySensitivity
      });
      omittedCount += 1;
      staleOmitted += 1;
      continue;
    }

    const est = Math.ceil(item.packBytes / 4);
    const nextBytes = runningBytes + item.packBytes;
    const nextTok = runningTok + est;
    const overBytes = nextBytes > maxBytes;
    const overTok = maxTok !== undefined && nextTok > maxTok;
    if (overBytes || overTok) {
      included.push({
        kind: item.kind,
        label: item.label,
        text: "",
        estimatedTokens: 0,
        omittedReason: overTok ? "pack_max_estimated_tokens" : "pack_max_bytes",
        memoryItemId: item.memoryItemId,
        memorySensitivity: item.memorySensitivity
      });
      omittedCount += 1;
      continue;
    }

    runningBytes = nextBytes;
    runningTok = nextTok;
    included.push({
      kind: item.kind,
      label: item.label,
      text: item.fullText,
      estimatedTokens: est,
      stale: item.stale && diet.stale_policy === "warn" ? true : undefined,
      includedOnce: true,
      memoryItemId: item.memoryItemId,
      memorySensitivity: item.memorySensitivity
    });
  }

  const packText = included
    .filter((e) => e.text.length > 0)
    .map((e) => `### ${e.label} (${e.kind})\n${e.text}`)
    .join("\n\n");

  const memoryPackedIds = included
    .filter((e) => e.kind === "memory" && e.text.length > 0 && e.memoryItemId)
    .map((e) => e.memoryItemId!);

  const sensitiveContextIncluded = included.some((e) => {
    if (!e.text) {
      return false;
    }
    if (workspaceNoteLooksSensitive(e.text)) {
      return true;
    }
    if (e.kind === "memory" && e.memorySensitivity === "sensitive") {
      return true;
    }
    if ((e.kind === "file" || e.kind === "workspace_note") && isSensitiveContextPath(e.label)) {
      return true;
    }
    return false;
  });

  const totals: ModelContextPackTotals = {
    bytes: runningBytes,
    estimatedTokens: runningTok,
    noteCount: included.filter((e) => e.kind === "note" && e.text).length,
    fileCount: included.filter((e) => e.kind === "file" && e.text).length,
    workspaceNoteCount: included.filter((e) => e.kind === "workspace_note" && e.text).length,
    memoryItemCount: included.filter((e) => e.kind === "memory" && e.text).length,
    includedCount: included.filter((e) => e.text.length > 0).length,
    omittedCount,
    staleOmittedCount: staleOmitted
  };

  if (recordLedger) {
    await appendLedgerEvent(ledgerFilePath(missionDirectory(paths.missionsDir, missionId)), {
      missionId,
      type: "context.pack_built",
      summary: `Model context pack built: ${totals.includedCount} included, ${totals.omittedCount} omitted.`,
      details: {
        bytes: totals.bytes,
        estimatedTokens: totals.estimatedTokens,
        includedCount: totals.includedCount,
        omittedCount: totals.omittedCount,
        staleOmittedCount: totals.staleOmittedCount,
        sensitiveContextIncluded,
        pack_max_bytes: maxBytes,
        pack_max_estimated_tokens: maxTok ?? null,
        stale_policy: diet.stale_policy,
        ...(memoryPackedIds.length > 0 ? { memory_item_ids: memoryPackedIds } : {})
      }
    });
  }

  return {
    entries: included,
    totals,
    sensitiveContextIncluded,
    packText
  };
}

async function resolveFileEntryForPack(
  entry: ContextEntry,
  cwd: string,
  policy: WorkspacePolicy,
  diet: ContextDietConfig
): Promise<ResolvedItem | undefined> {
  if (entry.type !== "file") {
    return undefined;
  }
  const guarded = resolveGuardedWorkspacePath(cwd, entry.source, policy);
  let content: string;
  let stale = false;
  try {
    const st = await stat(guarded.absolutePath);
    if (!st.isFile()) {
      return undefined;
    }
    content = await readFile(guarded.absolutePath, "utf8");
    const diskHash = sha256Utf8(content);
    const diskMtime = Math.trunc(st.mtimeMs);
    if (entry.contentSha256 && entry.contentSha256 !== diskHash) {
      stale = true;
    }
    if (entry.sourceMtimeMs !== undefined && diskMtime !== entry.sourceMtimeMs && !entry.contentSha256) {
      stale = true;
    }
  } catch {
    return undefined;
  }

  const truncated = truncateFileForPack(content, diet);
  const packBytes = Buffer.byteLength(truncated, "utf8");
  const hash = entry.contentSha256 ?? sha256Utf8(content);
  return {
    kind: "file",
    label: entry.source,
    fullText: truncated,
    packBytes,
    stale,
    sortWeight: 100 + packBytes,
    dedupeKey: `h:${hash}`
  };
}

async function readWorkspaceNotesPackSlice(
  workspaceDir: string,
  diet: ContextDietConfig
): Promise<ResolvedItem | undefined> {
  const filePath = path.join(workspaceDir, WORKSPACE_NOTES_FILE);
  try {
    const content = await readFile(filePath, "utf8");
    const truncated = truncateFileForPack(content, diet);
    const packBytes = Buffer.byteLength(truncated, "utf8");
    return {
      kind: "workspace_note",
      label: WORKSPACE_NOTES_FILE,
      fullText: truncated,
      packBytes,
      stale: false,
      sortWeight: 50,
      dedupeKey: `ws:${WORKSPACE_NOTES_FILE}`
    };
  } catch {
    return undefined;
  }
}

function truncateFileForPack(content: string, diet: ContextDietConfig): string {
  const { max_bytes, head_lines, tail_lines } = diet.file_truncation;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= max_bytes) {
    return content;
  }
  const lines = content.split(/\r?\n/);
  if (lines.length <= head_lines + tail_lines) {
    return content;
  }
  const head = lines.slice(0, head_lines).join("\n");
  const tail = lines.slice(-tail_lines).join("\n");
  const merged = `${head}\n\n… [truncated middle ${lines.length - head_lines - tail_lines} lines] …\n\n${tail}`;
  const mergedBytes = Buffer.byteLength(merged, "utf8");
  if (mergedBytes <= max_bytes) {
    return merged;
  }
  return `${merged.slice(0, max_bytes)}\n… [truncated to ${max_bytes} bytes] …`;
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
