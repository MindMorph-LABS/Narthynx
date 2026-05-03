import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { isSensitiveContextPath } from "../cli/shortcuts";
import { workspaceNoteLooksSensitive } from "../cli/workspace-notes";
import type { ContextDietConfig } from "../config/context-diet-config";
import { loadContextDietConfig } from "../config/context-diet-config";
import { loadWorkspacePolicy, type WorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths, type WorkspacePaths } from "../config/workspace";
import { formatMemoryLineForPack, listMemoryItemsForMissionContext } from "../memory/retrieval";
import { resolveGuardedWorkspacePath } from "../tools/path-guard";
import { readMissionContextIndex, sha256Utf8 } from "../missions/context";
import { appendLedgerEvent, ledgerFilePath } from "../missions/ledger";
import { createMissionStore, missionDirectory } from "../missions/store";
import { createContextPacketId } from "../utils/ids";
import type { BudgetCandidate } from "./budget";
import { applyPackBudget, prepareSortedCandidates } from "./budget";
import { rollupFingerprints } from "./cache";
import { truncateFileForPack } from "./compression";
import { tryGitDiffForTrackedPath } from "./git-snippet";
import type {
  CacheStats,
  ContextItem,
  ContextItemKind,
  ContextPacket,
  ContextPacketTotals,
  ContextPacketTrigger,
  ExcludedItem
} from "./types";
import { CONTEXT_PACKET_SCHEMA_VERSION } from "./types";
import { relevanceKeywords, relevanceScore } from "./relevance";
import { classifyItemSensitivity, routingHintForSensitivity } from "./sensitive-filter";
import { writeContextPacketArtifact } from "./manifest";

const WORKSPACE_NOTES_FILE = "workspace-notes.md";

export interface CompileContextPacketOptions {
  cwd: string;
  missionId: string;
  trigger: ContextPacketTrigger;
  /** When false, skips ledger persistence and artifact writes (dry-run previews). */
  persist?: boolean;
}

export interface CompileContextPacketResult {
  packet: ContextPacket;
}

function nextCandId(kind: ContextItemKind, n: number): string {
  return `ctx_${kind}_${n}`;
}

async function chooseFileBodyAsync(opts: {
  cwd: string;
  relativePath: string;
  raw: string;
  diet: ContextDietConfig;
}): Promise<{ display: string; sourceMode: "full_file" | "git_diff" | "git_diff_fallback_full"; diffHint?: boolean }> {
  const truncatedFull = truncateFileForPack(opts.raw, opts.diet);
  const fullBytes = Buffer.byteLength(truncatedFull, "utf8"); // compares diff vs truncated file body

  if (opts.diet.file_context_mode === "full") {
    return { display: truncatedFull, sourceMode: "full_file" };
  }

  let diffSnippet: string | undefined;
  try {
    const chunk = await tryGitDiffForTrackedPath(
      opts.cwd,
      opts.relativePath.replace(/\\/g, "/"),
      opts.diet.git_diff_max_chars
    );
    diffSnippet = chunk;
  } catch {
    diffSnippet = undefined;
  }

  const wrapDiff = (d: string) =>
    [`### git diff (${opts.relativePath})`, "```diff", d || "(empty working tree delta)", "```"].join("\n");

  if (opts.diet.file_context_mode === "diff") {
    if (diffSnippet === undefined) {
      return { display: truncatedFull, sourceMode: "git_diff_fallback_full", diffHint: true };
    }
    const wrapped = wrapDiff(diffSnippet);
    const afterTruncate = truncateFileForPack(wrapped, opts.diet);
    return { display: afterTruncate, sourceMode: "git_diff" };
  }

  // auto
  if (diffSnippet !== undefined && diffSnippet.length > 0) {
    const wrapped = wrapDiff(diffSnippet);
    const afterTruncate = truncateFileForPack(wrapped, opts.diet);
    const diffBytes = Buffer.byteLength(afterTruncate, "utf8");
    if (diffBytes > 0 && diffBytes <= fullBytes * 1.05) {
      return { display: afterTruncate, sourceMode: "git_diff" };
    }
  }
  return { display: truncatedFull, sourceMode: "full_file" };
}

function packTotalsFromItems(
  items: ContextItem[],
  runningBytes: number,
  runningTokens: number,
  omittedCount: number,
  staleOmittedCount: number,
  exclusionLen: number
): ContextPacketTotals {
  const withText = (k: ContextItemKind) =>
    items.filter((e) => e.kind === k && e.included && e.text.length > 0).length;
  return {
    bytes: runningBytes,
    estimatedTokens: runningTokens,
    noteCount: withText("note"),
    fileCount: withText("file"),
    workspaceNoteCount: withText("workspace_note"),
    memoryItemCount: withText("memory"),
    includedCount: items.filter((e) => e.included && e.text.length > 0).length,
    omittedCount,
    staleOmittedCount,
    exclusionCount: exclusionLen
  };
}

async function collectWorkspaceNotes(paths: WorkspacePaths, diet: ContextDietConfig, policy: WorkspacePolicy, kw: Set<string>): Promise<BudgetCandidate[]> {
  const out: BudgetCandidate[] = [];
  const filePath = path.join(paths.workspaceDir, WORKSPACE_NOTES_FILE);
  let seq = 0;
  try {
    const raw = await readFile(filePath, "utf8");
    const originalBytes = Buffer.byteLength(raw, "utf8");
    const hash = sha256Utf8(raw);
    const truncated = truncateFileForPack(raw, diet);
    const relevanceHit = relevanceScore(`${WORKSPACE_NOTES_FILE}\n${raw.slice(0, 600)}`, kw);
    const sens = classifyItemSensitivity({ kind: "workspace_note", label: WORKSPACE_NOTES_FILE, text: truncated });
    const rn = routingHintForSensitivity(sens, policy);
    const packBytes = Buffer.byteLength(truncated, "utf8");
    const ratio = originalBytes <= 0 ? undefined : Math.min(1, packBytes / originalBytes);
    out.push({
      id: nextCandId("workspace_note", ++seq),
      kind: "workspace_note",
      label: WORKSPACE_NOTES_FILE,
      packText: truncated,
      packBytes,
      stale: false,
      sortWeight: 50,
      relevanceHit,
      dedupeKey: `ws:${WORKSPACE_NOTES_FILE}`,
      sensitivity: sens,
      routingNote: rn,
      originalBytes,
      includedBytes: packBytes,
      compressionRatio: ratio,
      reasonIncluded: relevanceHit > 0 ? `keyword_overlap(${relevanceHit})` : "workspace_wide_notes",
      contentSha256: hash,
      sourceMode: "full_file"
    });
  } catch {
    /* optional */
  }
  return out;
}

export async function compileContextPacket(options: CompileContextPacketOptions): Promise<CompileContextPacketResult> {
  const { cwd, missionId } = options;
  const persist = options.persist !== false;
  const paths = resolveWorkspacePaths(cwd);

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

  const goalCorpus = `${mission.goal}\n${mission.title}`.trim();
  const keywords = relevanceKeywords(goalCorpus);

  const excluded: ExcludedItem[] = [];
  let exclusionSeq = 0;
  let candSeq = 0;

  const pending: BudgetCandidate[] = [];

  let noteCursor = 0;

  const pushExcluded = (label: string, category: ExcludedItem["category"], detail?: string) => {
    excluded.push({
      id: `exc_${missionId}_${++exclusionSeq}`,
      label,
      category,
      detail
    });
  };

  for (const entry of index.entries) {
    if (entry.type === "note") {
      const text = mission.context.notes[noteCursor];
      noteCursor += 1;
      if (entry.duplicateOf || text === undefined) {
        continue;
      }
      const originalBytes = Buffer.byteLength(text, "utf8");
      const hash = entry.contentSha256 ?? sha256Utf8(text);
      const truncated = truncateFileForPack(text, diet);
      const relevanceHit = relevanceScore(`${text.slice(0, 600)} note@${entry.addedAt}`, keywords);
      const sens = classifyItemSensitivity({ kind: "note", label: `note@${entry.addedAt}`, text: truncated });
      const rn = routingHintForSensitivity(sens, policy.value);
      const pb = Buffer.byteLength(truncated, "utf8");
      const ratio = originalBytes <= 0 ? undefined : Math.min(1, pb / originalBytes);
      pending.push({
        id: nextCandId("note", ++candSeq),
        kind: "note",
        label: `note@${entry.addedAt}`,
        packText: truncated,
        packBytes: pb,
        stale: false,
        sortWeight: 0,
        relevanceHit,
        dedupeKey: `h:${hash}`,
        sensitivity: sens,
        routingNote: rn,
        originalBytes,
        includedBytes: pb,
        compressionRatio: ratio,
        reasonIncluded: relevanceHit > 0 ? `keyword_overlap(${relevanceHit})` : "mission_note",
        contentSha256: hash,
        sourceMode: "full_file"
      });
      continue;
    }

    if (entry.duplicateOf) {
      continue;
    }

    try {
      const guarded = resolveGuardedWorkspacePath(cwd, entry.source, policy.value);
      const st = await stat(guarded.absolutePath);
      if (!st.isFile()) {
        pushExcluded(entry.source, "unreadable_file", "not a file");
        continue;
      }
      const raw = await readFile(guarded.absolutePath, "utf8");
      let stale = false;
      const diskHash = sha256Utf8(raw);
      const diskMtime = Math.trunc(st.mtimeMs);
      if (entry.contentSha256 && entry.contentSha256 !== diskHash) {
        stale = true;
      }
      if (entry.sourceMtimeMs !== undefined && diskMtime !== entry.sourceMtimeMs && !entry.contentSha256) {
        stale = true;
      }
      const chosen = await chooseFileBodyAsync({
        cwd,
        relativePath: guarded.relativePath,
        raw,
        diet
      });
      if (diet.file_context_mode === "diff" && chosen.sourceMode === "git_diff_fallback_full") {
        pushExcluded(entry.source, "git_diff_failed", "git diff unavailable; used truncated file snapshot");
      }
      const truncatedBody = truncateFileForPack(chosen.display, diet);
      const relevanceHit = relevanceScore(`${guardPathLabel(entry.source)}\n${raw.slice(0, 480)}`, keywords);
      const sens = classifyItemSensitivity({ kind: "file", label: entry.source, text: truncatedBody });
      const rn = routingHintForSensitivity(sens, policy.value);
      const originalBytes = Buffer.byteLength(raw, "utf8");
      const pb = Buffer.byteLength(truncatedBody, "utf8");
      const ratio = originalBytes <= 0 ? undefined : Math.min(1, pb / originalBytes);
      pending.push({
        id: nextCandId("file", ++candSeq),
        kind: "file",
        label: entry.source,
        packText: truncatedBody,
        packBytes: pb + 0,
        stale,
        sortWeight: 100 + pb,
        relevanceHit,
        dedupeKey: `h:${entry.contentSha256 ?? diskHash}`,
        sensitivity: sens,
        routingNote: rn,
        originalBytes,
        includedBytes: pb,
        compressionRatio: ratio,
        reasonIncluded:
          relevanceHit > 0
            ? `keyword_overlap(${relevanceHit});${chosen.sourceMode === "git_diff" ? "git_diff" : "file"}`
            : chosen.sourceMode === "git_diff"
              ? "git_diff_smaller_or_auto"
              : "context_file_attachment",
        contentSha256: diskHash,
        sourceMode: chosen.sourceMode
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/blocked by policy deny|outside the workspace/i.test(msg)) {
        pushExcluded(entry.source, "policy_deny_path", msg);
      } else {
        pushExcluded(entry.source, "unreadable_file", msg);
      }
    }
  }

  if (diet.include_workspace_notes) {
    pending.push(...(await collectWorkspaceNotes(paths, diet, policy.value, keywords)));
  }

  if (policy.value.memory_storage !== "off") {
    const memRows = await listMemoryItemsForMissionContext(paths, missionId, policy.value);
    const cite = policy.value.memory_mission_citations_required;
    for (const item of memRows) {
      const truncatedText = truncateFileForPack(item.text, diet);
      const line = formatMemoryLineForPack({ ...item, text: truncatedText }, cite);
      const packBytes = Buffer.byteLength(line, "utf8");
      const originalBytes = Buffer.byteLength(item.text, "utf8");
      const sens = classifyItemSensitivity({
        kind: "memory",
        label: cite ? `memory@${item.id}` : "memory",
        text: line,
        memorySensitivity: item.sensitivity
      });
      const rn = routingHintForSensitivity(sens, policy.value);
      const ratio = originalBytes <= 0 ? undefined : Math.min(1, packBytes / originalBytes);
      const relevanceHit = relevanceScore(`${item.text.slice(0, 400)}`, keywords);
      pending.push({
        id: nextCandId("memory", ++candSeq),
        kind: "memory",
        label: cite ? `memory@${item.id}` : "memory",
        packText: line,
        packBytes,
        stale: false,
        sortWeight: 62,
        relevanceHit,
        dedupeKey: `mem:${item.id}`,
        memoryItemId: item.id,
        memorySensitivity: item.sensitivity,
        sensitivity: sens,
        routingNote: rn,
        originalBytes,
        includedBytes: packBytes,
        compressionRatio: ratio,
        reasonIncluded: relevanceHit > 0 ? `keyword_overlap(${relevanceHit})` : "governed_memory_store",
        sourceMode: "full_file"
      });
    }
  }

  const sorted = prepareSortedCandidates(pending);
  const { items, runningBytes, runningTokens, omittedCount, staleOmittedCount } = applyPackBudget(sorted, diet);

  const packText = items
    .filter((e) => e.included && e.text.length > 0)
    .map((e) => `### ${e.label} (${e.kind})\n${e.text}`)
    .join("\n\n");

  const fpRoll = rollupFingerprints(items);
  const cache: CacheStats = { fingerprints: fpRoll.count };

  const packetId = createContextPacketId();
  const totals = packTotalsFromItems(items, runningBytes, runningTokens, omittedCount, staleOmittedCount, excluded.length);

  const sensitiveContextIncluded = items.some((e) => {
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

  const packet: ContextPacket = {
    schema: CONTEXT_PACKET_SCHEMA_VERSION,
    id: packetId,
    missionId,
    trigger: options.trigger,
    createdAt: new Date().toISOString(),
    items,
    totals,
    excluded,
    sensitiveContextIncluded,
    packText,
    cache
  };

  if (persist) {
    const missionDir = missionDirectory(paths.missionsDir, missionId);
    const { relativePath } = await writeContextPacketArtifact(missionDir, packet);
    const ledgerPath = ledgerFilePath(missionDir);
    const memoryPackedIds = items
      .filter((e) => e.kind === "memory" && e.included && e.text.length > 0 && e.memoryItemId)
      .map((e) => e.memoryItemId!);

    const omitReasonCounts: Record<string, number> = {};
    for (const it of items) {
      if (it.omitReason) {
        omitReasonCounts[it.omitReason] = (omitReasonCounts[it.omitReason] ?? 0) + 1;
      }
    }
    const exclusionCounts: Record<string, number> = {};
    for (const ex of excluded) {
      exclusionCounts[ex.category] = (exclusionCounts[ex.category] ?? 0) + 1;
    }

    await appendLedgerEvent(ledgerPath, {
      missionId,
      type: "context.packet_logged",
      summary: `Context packet ${packetId}: ${totals.includedCount} included, ${totals.omittedCount} omitted.`,
      details: {
        packet_id: packetId,
        trigger: options.trigger,
        artifact_relative_path: relativePath,
        bytes: totals.bytes,
        estimatedTokens: totals.estimatedTokens,
        includedCount: totals.includedCount,
        omittedCount: totals.omittedCount,
        staleOmittedCount: totals.staleOmittedCount,
        sensitiveContextIncluded,
        pack_max_bytes: diet.pack_max_bytes,
        pack_max_estimated_tokens: diet.pack_max_estimated_tokens ?? null,
        stale_policy: diet.stale_policy,
        file_context_mode: diet.file_context_mode,
        item_counts_by_kind: {
          note: totals.noteCount,
          file: totals.fileCount,
          workspace_note: totals.workspaceNoteCount,
          memory: totals.memoryItemCount
        },
        omitted_counts_by_reason: omitReasonCounts,
        exclusion_counts_by_category: exclusionCounts,
        ...(memoryPackedIds.length > 0 ? { memory_item_ids: memoryPackedIds } : {})
      }
    });

    await appendLedgerEvent(ledgerPath, {
      missionId,
      type: "context.pack_built",
      summary: `Model context pack built: ${totals.includedCount} included, ${totals.omittedCount} omitted.`,
      details: {
        context_packet_id: packetId,
        bytes: totals.bytes,
        estimatedTokens: totals.estimatedTokens,
        includedCount: totals.includedCount,
        omittedCount: totals.omittedCount,
        staleOmittedCount: totals.staleOmittedCount,
        sensitiveContextIncluded,
        pack_max_bytes: diet.pack_max_bytes,
        pack_max_estimated_tokens: diet.pack_max_estimated_tokens ?? null,
        stale_policy: diet.stale_policy,
        ...(memoryPackedIds.length > 0 ? { memory_item_ids: memoryPackedIds } : {})
      }
    });
  }

  return { packet };
}

function guardPathLabel(source: string): string {
  return source;
}
