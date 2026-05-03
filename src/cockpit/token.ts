import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspacePaths } from "../config/workspace";

const TOKEN_FILE = "token";
const TOKEN_BYTES = 24;

export interface CockpitTokenResult {
  token: string;
  wroteFile: boolean;
}

/**
 * Auth secret for /api/* — env `NARTHYNX_COCKPIT_TOKEN` wins; else `.narthynx/cockpit/token`.
 */
export async function resolveCockpitAuthToken(paths: WorkspacePaths): Promise<CockpitTokenResult> {
  const env = process.env.NARTHYNX_COCKPIT_TOKEN?.trim();
  if (env && env.length > 0) {
    return { token: env, wroteFile: false };
  }

  const cockpitDir = path.join(paths.workspaceDir, "cockpit");
  const tokenPath = path.join(cockpitDir, TOKEN_FILE);

  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (existing.length > 0) {
      return { token: existing, wroteFile: false };
    }
  } catch {
    /* missing */
  }

  await mkdir(cockpitDir, { recursive: true });
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  await writeFile(tokenPath, `${token}\n`, "utf8");
  return { token, wroteFile: true };
}
