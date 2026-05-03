import { appendFile, mkdir } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._\-+/=]+\b/gi,
  /\bgsk_[A-Za-z0-9]+\b/gi,
  /\bgh[pousr]_[A-Za-z0-9]+\b/gi,
  /\bsk-[A-Za-z0-9]+\b/gi
];

/** Best-effort redaction for daemon file logs. */
export function redactLogMessage(message: string): string {
  let out = message;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export async function appendDaemonLog(paths: WorkspacePaths, line: string): Promise<void> {
  await mkdir(paths.daemonDir, { recursive: true });
  const safe = redactLogMessage(line);
  await appendFile(paths.daemonLogFile, `${safe}\n`, "utf8");
}
