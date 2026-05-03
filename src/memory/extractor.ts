import { workspaceNoteLooksSensitive } from "../cli/workspace-notes";

import type { MemorySensitivity } from "./schema";

/** Deterministic heuristic only — Phase 18 honors “don’t infer sensitive attributes unnecessarily”. */
export function classifyMemorySensitivity(text: string): MemorySensitivity {
  if (workspaceNoteLooksSensitive(text)) {
    return "sensitive";
  }
  const t = text.toLowerCase();
  if (
    /\b(password|passwd|api[_ ]?key|secret|token|bearer\s|private\skey|ssn\b|credit\s?card)\b/.test(t)
  ) {
    return "sensitive";
  }
  return "none";
}
