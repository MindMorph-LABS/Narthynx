import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";
import { createMissionStore } from "../missions/store";
import { companionMetaSchema, type CompanionMeta } from "./models";
import { ensureCompanionDirs } from "./store";

export async function ensureCompanionHostMissionId(cwd: string, paths: WorkspacePaths): Promise<string> {
  await ensureCompanionDirs(paths);
  await mkdir(paths.companionDir, { recursive: true });

  let meta: CompanionMeta | undefined;
  try {
    const raw = await readFile(paths.companionMetaFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const r = companionMetaSchema.safeParse(parsed);
    if (r.success) {
      meta = r.data;
    }
  } catch {
    /* fresh */
  }

  const store = createMissionStore(cwd);
  if (meta) {
    try {
      await store.readMission(meta.companion_host_mission_id);
      return meta.companion_host_mission_id;
    } catch {
      /* stale */
    }
  }

  const m = await store.createMission({
    goal: "Workspace companion host mission (Frontier F17). Model calls for companion chat are attributed here; execution remains in child missions.",
    title: "Companion host"
  });
  const next: CompanionMeta = { companion_host_mission_id: m.id };
  await writeFile(paths.companionMetaFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return m.id;
}
