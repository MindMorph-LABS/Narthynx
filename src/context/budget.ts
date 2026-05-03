import type { ContextDietConfig } from "../config/context-diet-config";
import type { ContextItem, ContextItemKind } from "./types";

export interface BudgetCandidate {
  id: string;
  kind: ContextItemKind;
  label: string;
  /** Serialized body for inclusion */
  packText: string;
  packBytes: number;
  stale: boolean;
  sortWeight: number;
  relevanceHit: number;
  dedupeKey: string;
  memoryItemId?: string;
  memorySensitivity?: "none" | "low" | "sensitive";
  sensitivity: ContextItem["sensitivity"];
  routingNote: ContextItem["routingNote"];
  originalBytes: number;
  includedBytes: number;
  compressionRatio?: number;
  reasonIncluded: string;
  sourceMode?: ContextItem["sourceMode"];
  /** Optional fingerprint of raw/source body */
  contentSha256?: string;
}

export interface BudgetOutcome {
  items: ContextItem[];
  runningBytes: number;
  runningTokens: number;
  omittedCount: number;
  staleOmittedCount: number;
}

/**
 * Inclusion order: higher relevance hits first; then ascending legacy sortWeight for stability,
 * then label for determinism.
 */
export function prepareSortedCandidates(rows: BudgetCandidate[]): BudgetCandidate[] {
  return [...rows].sort((a, b) => {
    const r = b.relevanceHit - a.relevanceHit;
    if (r !== 0) {
      return r;
    }
    const sw = a.sortWeight - b.sortWeight;
    if (sw !== 0) {
      return sw;
    }
    return a.label.localeCompare(b.label);
  });
}

export function applyPackBudget(sorted: BudgetCandidate[], diet: ContextDietConfig): BudgetOutcome {
  const seen = new Set<string>();
  const unique: BudgetCandidate[] = [];
  for (const c of sorted) {
    if (seen.has(c.dedupeKey)) {
      continue;
    }
    seen.add(c.dedupeKey);
    unique.push(c);
  }

  const items: ContextItem[] = [];
  let runningBytes = 0;
  let runningTok = 0;
  let omittedCount = 0;
  let staleOmitted = 0;
  const maxBytes = diet.pack_max_bytes;
  const maxTok = diet.pack_max_estimated_tokens;

  for (const cand of unique) {
    if (cand.stale && diet.stale_policy === "omit_from_pack") {
      items.push({
        id: cand.id,
        kind: cand.kind,
        label: cand.label,
        text: "",
        included: false,
        omitReason: "stale_file_omitted",
        sensitivity: cand.sensitivity,
        tokenEstimate: 0,
        stale: true,
        routingNote: cand.routingNote,
        memoryItemId: cand.memoryItemId,
        dedupeKey: cand.dedupeKey,
        compressionRatio: cand.compressionRatio,
        originalBytes: cand.originalBytes,
        includedBytes: 0,
        reasonIncluded: cand.reasonIncluded,
        sourceMode: cand.sourceMode,
        contentSha256: cand.contentSha256
      });
      omittedCount += 1;
      staleOmitted += 1;
      continue;
    }

    const est = Math.ceil(cand.packBytes / 4);
    const nextBytes = runningBytes + cand.packBytes;
    const nextTok = runningTok + est;
    const overBytes = nextBytes > maxBytes;
    const overTok = maxTok !== undefined && nextTok > maxTok;

    if (overBytes || overTok) {
      items.push({
        id: cand.id,
        kind: cand.kind,
        label: cand.label,
        text: "",
        included: false,
        omitReason: overTok ? "pack_max_estimated_tokens" : "pack_max_bytes",
        sensitivity: cand.sensitivity,
        tokenEstimate: est,
        stale: cand.stale && diet.stale_policy === "warn" ? true : undefined,
        routingNote: cand.routingNote,
        memoryItemId: cand.memoryItemId,
        dedupeKey: cand.dedupeKey,
        compressionRatio: cand.compressionRatio,
        originalBytes: cand.originalBytes,
        includedBytes: 0,
        reasonIncluded: cand.reasonIncluded,
        sourceMode: cand.sourceMode,
        contentSha256: cand.contentSha256
      });
      omittedCount += 1;
      continue;
    }

    runningBytes = nextBytes;
    runningTok = nextTok;

    items.push({
      id: cand.id,
      kind: cand.kind,
      label: cand.label,
      text: cand.packText,
      included: true,
      sensitivity: cand.sensitivity,
      tokenEstimate: est,
      stale: cand.stale && diet.stale_policy === "warn" ? true : undefined,
      routingNote: cand.routingNote,
      memoryItemId: cand.memoryItemId,
      dedupeKey: cand.dedupeKey,
      compressionRatio: cand.compressionRatio,
      originalBytes: cand.originalBytes,
      includedBytes: cand.packBytes,
      reasonIncluded: cand.reasonIncluded,
      omitReason: undefined,
      sourceMode: cand.sourceMode,
      contentSha256: cand.contentSha256
    });
  }

  return { items, runningBytes, runningTokens: runningTok, omittedCount, staleOmittedCount: staleOmitted };
}
