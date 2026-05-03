import { mkdir } from "node:fs/promises";

import { resolveWorkspacePaths } from "../config/workspace";

import { createDaemonQueueService } from "./queue";

/**
 * Best-effort: persists a daemon queue job when trigger ingest creates missions.
 * If the daemon is not running yet, jobs are replayed when it starts.
 */
export async function enqueueTriggerFollowupJob(
  cwd: string,
  params: {
    triggerEventId: string;
    missionId?: string;
    outcome?: string;
  }
): Promise<void> {
  const paths = resolveWorkspacePaths(cwd);
  await mkdir(paths.daemonDir, { recursive: true });
  const queue = createDaemonQueueService(paths);
  await queue.enqueue(
    {
      kind: "trigger_followup",
      triggerEventId: params.triggerEventId,
      missionId: params.missionId,
      outcome: params.outcome
    },
    "trigger_ingest"
  );
}
