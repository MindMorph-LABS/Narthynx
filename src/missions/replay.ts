import { readLedgerEvents, type LedgerEvent, ledgerFilePath } from "./ledger";
import { missionDirectory } from "./store";

export interface ReplayResult {
  events: LedgerEvent[];
  missionId: string;
}

export function createReplayService() {
  return {
    async replayMission(
      missionId: string,
      cwd = process.cwd()
    ): Promise<ReplayResult> {
      // Read mission to verify it exists
      const { createMissionStore } = await import("./store");
      const paths = await import("../config/workspace");
      const missionStore = createMissionStore(cwd);
      await missionStore.readMission(missionId); // This will throw if mission doesn't exist

      // Read all ledger events
      const missionDir = missionDirectory(
        paths.resolveWorkspacePaths(cwd).missionsDir,
        missionId
      );
      const events = await readLedgerEvents(ledgerFilePath(missionDir), {
        allowMissing: true
      });

      return {
        events,
        missionId
      };
    }
  };
}
