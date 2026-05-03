import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MISSION_ID_RE = /^m_[a-z0-9_-]+$/;

/** Whether any mission has at least one vault entry (for doctor; avoids importing vault-store → store → workspace). */
export async function anyMissionUsesVault(missionsDir: string): Promise<boolean> {
  let dirs: string[];
  try {
    dirs = await readdir(missionsDir);
  } catch {
    return false;
  }
  for (const id of dirs) {
    if (!MISSION_ID_RE.test(id)) {
      continue;
    }
    const manifestPath = path.join(missionsDir, id, "vault", "manifest.json");
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as { entries?: unknown[] };
      if (Array.isArray(parsed.entries) && parsed.entries.length > 0) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}
