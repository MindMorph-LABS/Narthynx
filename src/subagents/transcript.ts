import type { LedgerEventType } from "../missions/ledger";

export type TranscriptEntry =
  | { kind: "note"; label: string; detail?: Record<string, unknown> }
  | { kind: "ledger"; eventType: LedgerEventType };

export class SubagentTranscript {
  private readonly entries: TranscriptEntry[] = [];

  pushNote(label: string, detail?: Record<string, unknown>): void {
    this.entries.push({ kind: "note", label, detail });
  }

  ledgerHint(eventType: LedgerEventType): void {
    this.entries.push({ kind: "ledger", eventType });
  }

  sanitizeForLedger(maxEntries = 32): Record<string, unknown> {
    return {
      truncated: this.entries.length > maxEntries,
      entries: this.entries.slice(-maxEntries).map((entry) =>
        entry.kind === "ledger" ? { kind: entry.kind, eventType: entry.eventType } : entry
      )
    };
  }
}
