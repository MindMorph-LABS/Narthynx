import { mkdir, appendFile, readFile } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";
import { createDaemonEventRowId } from "../utils/ids";

import { appendDaemonLog } from "./log";
import type { DaemonEventRow } from "./schema";
import { daemonEventRowSchema } from "./schema";

export type DaemonEventSubscriber = (event: DaemonEventRow) => void;

export function createDaemonEventBus(paths: WorkspacePaths) {
  const subscribers: DaemonEventSubscriber[] = [];

  return {
    subscribe(fn: DaemonEventSubscriber): () => void {
      subscribers.push(fn);
      return () => {
        const i = subscribers.indexOf(fn);
        if (i >= 0) {
          subscribers.splice(i, 1);
        }
      };
    },

    async append(event: Omit<DaemonEventRow, "id" | "ts"> & { id?: string; ts?: string }): Promise<DaemonEventRow> {
      const row: DaemonEventRow = daemonEventRowSchema.parse({
        id: event.id ?? createDaemonEventRowId(),
        ts: event.ts ?? new Date().toISOString(),
        type: event.type,
        summary: event.summary,
        details: event.details
      });
      await mkdir(paths.daemonDir, { recursive: true });
      await appendFile(paths.daemonEventsFile, `${JSON.stringify(row)}\n`, "utf8");
      for (const s of subscribers) {
        try {
          s(row);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await appendDaemonLog(paths, `daemon event subscriber error: ${msg}`);
        }
      }
      return row;
    }
  };
}

export type DaemonEventBus = ReturnType<typeof createDaemonEventBus>;

export async function readDaemonEvents(paths: WorkspacePaths, opts?: { since?: string; limit?: number }): Promise<DaemonEventRow[]> {
  let raw: string;
  try {
    raw = await readFile(paths.daemonEventsFile, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const sinceMs = opts?.since ? Date.parse(opts.since) : NaN;
  const useSince = Number.isFinite(sinceMs);
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 5000);
  const out: DaemonEventRow[] = [];

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      const row = daemonEventRowSchema.parse(JSON.parse(t));
      if (useSince && Date.parse(row.ts) <= sinceMs) {
        continue;
      }
      out.push(row);
    } catch {
      /* skip corrupt */
    }
  }
  return out.slice(-limit);
}
