import { resolveWorkspacePaths } from "../config/workspace";
import { appendLedgerEvent, ledgerFilePath } from "../missions/ledger";
import { createMissionStore, missionDirectory } from "../missions/store";

import type { DaemonEventBus } from "./event-bus";

/**
 * Missions left in `running` after a crash have no live executor; move to `paused` for safe human resume.
 */
export async function reconcileRunningMissionsOnDaemonStartup(cwd: string, eventBus: DaemonEventBus): Promise<number> {
  const paths = resolveWorkspacePaths(cwd);
  const store = createMissionStore(cwd);
  const missions = await store.listMissions();
  let n = 0;
  for (const m of missions) {
    if (m.state !== "running") {
      continue;
    }
    await store.updateMissionState(m.id, "paused");
    const dir = missionDirectory(paths.missionsDir, m.id);
    await appendLedgerEvent(ledgerFilePath(dir), {
      missionId: m.id,
      type: "daemon.recovery",
      summary: "Mission paused on daemon startup — previous run had no supervisor",
      details: { from: "running", to: "paused", reason: "daemon_startup_reconcile" }
    });
    await eventBus.append({
      type: "mission.recovered",
      summary: `Mission ${m.id} transitioned running → paused (daemon startup)`,
      details: { missionId: m.id }
    });
    n++;
  }
  return n;
}
