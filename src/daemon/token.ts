import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";

const TOKEN_BYTES = 24;

export interface DaemonTokenResult {
  token: string;
  wroteFile: boolean;
}

/**
 * Auth for daemon HTTP API — env `NARTHYNX_DAEMON_TOKEN` wins; else `.narthynx/daemon/token`.
 */
export async function resolveDaemonAuthToken(paths: WorkspacePaths): Promise<DaemonTokenResult> {
  const env = process.env.NARTHYNX_DAEMON_TOKEN?.trim();
  if (env && env.length > 0) {
    return { token: env, wroteFile: false };
  }

  try {
    const existing = (await readFile(paths.daemonTokenFile, "utf8")).trim();
    if (existing.length > 0) {
      return { token: existing, wroteFile: false };
    }
  } catch {
    /* missing */
  }

  await mkdir(paths.daemonDir, { recursive: true });
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  await writeFile(paths.daemonTokenFile, `${token}\n`, "utf8");
  return { token, wroteFile: true };
}
