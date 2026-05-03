import { mkdir, writeFile } from "node:fs/promises";

import type { WorkspacePolicy } from "../config/load";
import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { createMissionExecutor } from "../agent/executor";
import { createMissionStore } from "../missions/store";

import type { DaemonEventBus } from "./event-bus";
import { appendDaemonLog } from "./log";
import { classifyJobAgainstDaemonPolicy } from "./policy-gate";
import { appendQueueOp, readAllQueueOps, deriveQueueFromOps } from "./queue";
import type { DaemonJobPayload } from "./schema";
import type { NotificationSink } from "./notifications";

export interface WorkerContext {
  cwd: string;
  notificationSink: NotificationSink;
  eventBus: Pick<DaemonEventBus, "append">;
}

export async function handleDaemonJob(
  ctx: WorkerContext,
  job: DaemonJobPayload,
  policy: WorkspacePolicy
): Promise<void> {
  const paths = resolveWorkspacePaths(ctx.cwd);
  const gate = classifyJobAgainstDaemonPolicy(policy, job);
  if (!gate.ok) {
    await appendDaemonLog(paths, `job rejected: ${gate.reason}`);
    throw new Error(gate.reason);
  }

  const missionStore = createMissionStore(ctx.cwd);
  const executor = createMissionExecutor(ctx.cwd);

  switch (job.kind) {
    case "notify":
      await ctx.notificationSink.notify(job.message, job.level ?? "info");
      return;
    case "emit_event":
      await ctx.eventBus.append({
        type: job.type,
        summary: job.summary,
        details: job.payload
      });
      return;
    case "scheduled_tick":
      await ctx.eventBus.append({
        type: "daemon.schedule.tick",
        summary: `Schedule fired: ${job.scheduleId}`,
        details: { scheduleId: job.scheduleId }
      });
      return;
    case "trigger_followup":
      await ctx.eventBus.append({
        type: "daemon.trigger.followup",
        summary: `Trigger follow-up: ${job.triggerEventId}`,
        details: { triggerEventId: job.triggerEventId, missionId: job.missionId, outcome: job.outcome }
      });
      return;
    case "create_mission": {
      const m = await missionStore.createMission({
        goal: job.goal,
        title: job.title
      });
      await ctx.eventBus.append({
        type: "daemon.mission.created",
        summary: `Daemon created mission ${m.id}`,
        details: { missionId: m.id, title: m.title }
      });
      return;
    }
    case "execute_mission": {
      const mission = await missionStore.readMission(job.missionId);
      const result =
        mission.state === "paused"
          ? await executor.resumeMission(job.missionId)
          : await executor.runMission(job.missionId);

      await ctx.eventBus.append({
        type: "daemon.executor.result",
        summary: `Executor ${result.status} for ${job.missionId}`,
        details: { missionId: job.missionId, status: result.status, approvalId: result.approvalId }
      });
      return;
    }
    default:
      throw new Error("Unsupported daemon job kind");
  }
}

export async function processNextQueueJob(ctx: WorkerContext, paths: ReturnType<typeof resolveWorkspacePaths>): Promise<boolean> {
  const policyResult = await loadWorkspacePolicy(paths.policyFile);
  if (!policyResult.ok) {
    await appendDaemonLog(paths, `worker skipped: invalid policy — ${policyResult.message}`);
    return false;
  }
  const policy = policyResult.value;

  const ops = await readAllQueueOps(paths);
  const snap = deriveQueueFromOps(ops);
  if (snap.processing) {
    return false;
  }
  const next = snap.pending[0];
  if (!next) {
    return false;
  }

  const now = new Date().toISOString();
  await appendQueueOp(paths, {
    v: 1,
    op: "start",
    ts: now,
    id: next.id,
    job: next.job
  });

  try {
    await handleDaemonJob(ctx, next.job, policy);
    await appendQueueOp(paths, {
      v: 1,
      op: "finish",
      ts: new Date().toISOString(),
      id: next.id,
      ok: true
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await appendQueueOp(paths, {
      v: 1,
      op: "finish",
      ts: new Date().toISOString(),
      id: next.id,
      ok: false,
      detail: msg
    });
    await appendDaemonLog(paths, `job ${next.id} failed: ${msg}`);
  }
  return true;
}

export async function writeDaemonStatusSnapshot(
  paths: ReturnType<typeof resolveWorkspacePaths>,
  body: Record<string, unknown>
): Promise<void> {
  await mkdir(paths.daemonDir, { recursive: true });
  await writeFile(paths.daemonStatusFile, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}
