import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { Hono } from "hono";

import { doctorWorkspace, resolveWorkspacePaths } from "../config/workspace";
import { loadWorkspacePolicy } from "../config/load";

import { appendDaemonLog } from "./log";
import { acquireDaemonInstance, ensureDaemonDir, readDaemonPid, isPidRunning } from "./process-manager";
import { reconcileOrphanProcessing, createDaemonQueueService } from "./queue";
import { createDaemonEventBus } from "./event-bus";
import { reconcileRunningMissionsOnDaemonStartup } from "./recovery";
import { resolveDaemonAuthToken } from "./token";
import { createDaemonHttpApp } from "./server";
import { ensureScheduleFile, maybeEnqueueScheduledJobs } from "./scheduler";
import { createLogNotificationSink } from "./notifications";
import { processNextQueueJob, writeDaemonStatusSnapshot } from "./worker";

const DEFAULT_DAEMON_PORT = 17891;

export function resolveDaemonPort(): number {
  const raw = process.env.NARTHYNX_DAEMON_PORT?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n < 65536) {
      return n;
    }
  }
  return DEFAULT_DAEMON_PORT;
}

export function resolveDaemonHost(): string {
  const h = process.env.NARTHYNX_DAEMON_HOST?.trim();
  return h && h.length > 0 ? h : "127.0.0.1";
}

export interface RunDaemonOptions {
  cwd: string;
  port: number;
  host: string;
  dangerListenOnLan: boolean;
}

/** Foreground daemon: lockfile, HTTP API, scheduler + worker ticks. Caller process must be the supervisee. */
export async function runDaemonForeground(options: RunDaemonOptions): Promise<void> {
  const paths = resolveWorkspacePaths(options.cwd);
  const doc = await doctorWorkspace(options.cwd);
  if (!doc.ok) {
    throw new Error("Workspace is not healthy. Run: narthynx init");
  }

  let host = options.host;
  if (options.dangerListenOnLan) {
    host = "0.0.0.0";
  }
  if (options.dangerListenOnLan && host !== "0.0.0.0") {
    throw new Error("Internal: dangerListenOnLan requires host 0.0.0.0");
  }

  await ensureDaemonDir(paths);
  const lock = await acquireDaemonInstance(paths, process.pid);
  const { token, wroteFile } = await resolveDaemonAuthToken(paths);
  if (wroteFile) {
    await appendDaemonLog(paths, "daemon wrote new API token to .narthynx/daemon/token");
  }

  await ensureScheduleFile(paths);
  await reconcileOrphanProcessing(paths);

  const eventBus = createDaemonEventBus(paths);
  const recoveredMissions = await reconcileRunningMissionsOnDaemonStartup(options.cwd, eventBus);
  if (recoveredMissions > 0) {
    await appendDaemonLog(paths, `daemon startup: reconciled ${recoveredMissions} running mission(s) -> paused`);
  }

  const queue = createDaemonQueueService(paths);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const notificationSink = createLogNotificationSink((line) => {
    void appendDaemonLog(paths, line);
  });

  const workerCtx = {
    cwd: options.cwd,
    notificationSink,
    eventBus
  };

  const meta = () => ({
    pid: process.pid,
    startedAt,
    uptimeMs: Date.now() - startedMs,
    host,
    port: options.port
  });

  const api = createDaemonHttpApp({
    cwd: options.cwd,
    bearerToken: token,
    queue,
    getListenMeta: meta
  });

  const root = new Hono();
  root.route("/api/daemon/v1", api);

  let server: Server | undefined;
  const tick = async (): Promise<void> => {
    try {
      const pol = await loadWorkspacePolicy(paths.policyFile);
      if (pol.ok) {
        await maybeEnqueueScheduledJobs(paths, (job) => queue.enqueue(job));
      }
      await processNextQueueJob(workerCtx, paths);
      const snap = await queue.snapshot();
      const pol2 = await loadWorkspacePolicy(paths.policyFile);
      await writeDaemonStatusSnapshot(paths, {
        ok: true,
        ...meta(),
        cwd: paths.rootDir,
        queue: {
          pending: snap.pending.length,
          processingId: snap.processing?.id ?? null,
          finishedTail: snap.finishedCount
        },
        policy_daemon_background_actions: pol2.ok ? pol2.value.daemon_background_actions : "unknown",
        doctor_ok: (await doctorWorkspace(options.cwd)).ok
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendDaemonLog(paths, `daemon tick error: ${msg}`);
    }
  };

  await tick();
  const workerTimer = setInterval(() => {
    void tick();
  }, 250);

  await new Promise<void>((resolveStart) => {
    server = serve(
      {
        fetch: root.fetch,
        port: options.port,
        hostname: host
      },
      (info) => {
        const urlHost = host === "0.0.0.0" ? "127.0.0.1" : host;
        void appendDaemonLog(
          paths,
          `daemon listening http://${urlHost}:${info.port}/api/daemon/v1 (pid ${process.pid})`
        );
        resolveStart();
      }
    );
  });

  const shutdown = async (): Promise<void> => {
    clearInterval(workerTimer);
    await new Promise<void>((res) => {
      if (server) {
        server.close(() => res());
      } else {
        res();
      }
    });
    await lock.release();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

export async function stopDaemonForWorkspace(cwd: string): Promise<{ stopped: boolean; message: string }> {
  const paths = resolveWorkspacePaths(cwd);
  const pid = await readDaemonPid(paths);
  if (pid === null) {
    return { stopped: false, message: "No daemon pid file — daemon may not be running." };
  }
  if (!isPidRunning(pid)) {
    return { stopped: false, message: `Stale pid ${pid} — not running.` };
  }
  try {
    process.kill(pid, "SIGTERM");
    return { stopped: true, message: `Sent SIGTERM to daemon pid ${pid}.` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { stopped: false, message: `Failed to signal pid ${pid}: ${msg}` };
  }
}
