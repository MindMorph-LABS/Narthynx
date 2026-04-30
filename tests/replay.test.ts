import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { initWorkspace } from "../src/config/workspace";
import { createReplayService } from "../src/missions/replay";
import { createMissionStore } from "../src/missions/store";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-replay-"));
}

describe("mission replay", () => {
  it("replays mission ledger events in order", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({
      goal: "Test mission for replay"
    });

    const replayService = createReplayService();
    const result = await replayService.replayMission(mission.id, cwd);

    expect(result.missionId).toBe(mission.id);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.type).toBe("mission.created");
    expect(result.events[1]?.type).toBe("plan.created");
  });

  it("handles mission with additional ledger events", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({
      goal: "Test mission with more events"
    });

    // Add a state change event
    await missionStore.updateMissionState(mission.id, "planning");

    const replayService = createReplayService();
    const result = await replayService.replayMission(mission.id, cwd);

    expect(result.events).toHaveLength(3);
    expect(result.events[0]?.type).toBe("mission.created");
    expect(result.events[1]?.type).toBe("plan.created");
    expect(result.events[2]?.type).toBe("mission.state_changed");
    expect(result.events[2]?.details).toEqual({
      from: "created",
      to: "planning"
    });
  });

  it("requires an initialized workspace", async () => {
    const cwd = await tempWorkspaceRoot();
    const replayService = createReplayService();

    await expect(
      replayService.replayMission("m_nonexistent", cwd)
    ).rejects.toThrow("Workspace is not initialized. Run: narthynx init");
  });

  it("returns empty events for missing ledger", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);

    const missionStore = createMissionStore(cwd);
    const mission = await missionStore.createMission({
      goal: "Test mission"
    });

    // Remove the ledger file to simulate missing ledger
    const { ledgerFilePath } = await import("../src/missions/ledger");
    const { missionDirectory } = await import("../src/missions/store");
    const missionDir = missionDirectory(
      (await import("../src/config/workspace")).resolveWorkspacePaths(cwd)
        .missionsDir,
      mission.id
    );
    await rm(ledgerFilePath(missionDir), { force: true });

    const replayService = createReplayService();
    const result = await replayService.replayMission(mission.id, cwd);

    expect(result.events).toHaveLength(0);
    expect(result.missionId).toBe(mission.id);
  });
});
