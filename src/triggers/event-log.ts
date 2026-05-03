import { appendFile, mkdir, readFile } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";
import type { TriggerLogLine } from "./schema";
import { triggerLogLineSchema } from "./schema";
import { triggerEventsPath } from "./paths";

export async function appendTriggerLog(paths: WorkspacePaths, line: TriggerLogLine): Promise<void> {
  const validated = triggerLogLineSchema.parse(line);
  await mkdir(paths.workspaceDir, { recursive: true });
  await appendFile(triggerEventsPath(paths), `${JSON.stringify(validated)}\n`, "utf8");
}

export async function readTriggerLogLines(paths: WorkspacePaths): Promise<TriggerLogLine[]> {
  let raw: string;
  try {
    raw = await readFile(triggerEventsPath(paths), "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String(e.code) : "";
    if (code === "ENOENT") {
      return [];
    }
    throw e;
  }

  const lines: TriggerLogLine[] = [];
  for (const row of raw.split("\n")) {
    const t = row.trim();
    if (!t) {
      continue;
    }
    try {
      lines.push(triggerLogLineSchema.parse(JSON.parse(t)));
    } catch {
      /* skip corrupt lines */
    }
  }
  return lines;
}
