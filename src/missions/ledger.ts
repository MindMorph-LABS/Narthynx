import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { createLedgerEventId } from "../utils/ids";

export const LEDGER_FILE_NAME = "ledger.jsonl";

export const ledgerEventTypeSchema = z.enum([
  "mission.created",
  "mission.state_changed",
  "plan.created",
  "plan.updated",
  "node.started",
  "node.completed",
  "node.failed",
  "tool.requested",
  "tool.approved",
  "tool.denied",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "checkpoint.created",
  "artifact.created",
  "model.called",
  "cost.recorded",
  "user.note",
  "error"
]);

export const ledgerEventSchema = z.object({
  id: z.string().regex(/^e_[a-z0-9_-]+$/),
  missionId: z.string().regex(/^m_[a-z0-9_-]+$/),
  type: ledgerEventTypeSchema,
  timestamp: z.string().datetime(),
  summary: z.string().min(1),
  details: z.record(z.unknown()).optional()
});

export type LedgerEventType = z.infer<typeof ledgerEventTypeSchema>;
export type LedgerEvent = z.infer<typeof ledgerEventSchema>;

export interface CreateLedgerEventInput {
  missionId: string;
  type: LedgerEventType;
  summary: string;
  details?: Record<string, unknown>;
  timestamp?: string;
}

export function ledgerFilePath(missionDir: string): string {
  return path.join(missionDir, LEDGER_FILE_NAME);
}

export function createLedgerEvent(input: CreateLedgerEventInput): LedgerEvent {
  return ledgerEventSchema.parse({
    id: createLedgerEventId(),
    missionId: input.missionId,
    type: input.type,
    timestamp: input.timestamp ?? new Date().toISOString(),
    summary: input.summary,
    details: input.details
  });
}

export async function appendLedgerEvent(filePath: string, input: CreateLedgerEventInput): Promise<LedgerEvent> {
  const event = createLedgerEvent(input);
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function readLedgerEvents(filePath: string, options: { allowMissing?: boolean } = {}): Promise<LedgerEvent[]> {
  let raw = "";

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" && options.allowMissing) {
      return [];
    }

    const message = error instanceof Error ? error.message : "Unknown ledger read failure";
    throw new Error(`Failed to read ledger at ${filePath}: ${message}`);
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events: LedgerEvent[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JSON";
      throw new Error(`Invalid ledger JSON at ${filePath}:${lineNumber}: ${message}`);
    }

    const parsed = ledgerEventSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new Error(`Invalid ledger event at ${filePath}:${lineNumber}: ${message}`);
    }

    events.push(parsed.data);
  }

  return events;
}
