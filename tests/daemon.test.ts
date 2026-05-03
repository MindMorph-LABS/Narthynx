import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import type { WorkspacePolicy } from "../src/config/load";
import { initWorkspace, resolveWorkspacePaths } from "../src/config/workspace";
import { createDaemonHttpApp } from "../src/daemon/server";
import { createDaemonEventBus } from "../src/daemon/event-bus";
import { classifyJobAgainstDaemonPolicy } from "../src/daemon/policy-gate";
import {
  appendQueueOp,
  createDaemonQueueService,
  deriveQueueFromOps,
  readAllQueueOps,
  reconcileOrphanProcessing
} from "../src/daemon/queue";
import { acquireDaemonInstance } from "../src/daemon/process-manager";
import { reconcileRunningMissionsOnDaemonStartup } from "../src/daemon/recovery";
import { enqueueTriggerFollowupJob } from "../src/daemon/trigger-bridge";
import type { DaemonQueueOp } from "../src/daemon/schema";
import { createMissionStore } from "../src/missions/store";
import { createDaemonJobId } from "../src/utils/ids";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-daemon-"));
}

const BASE_POLICY = {
  mode: "ask" as const,
  allow_network: false,
  shell: "ask" as const,
  filesystem: { read: ["."], write: ["."], deny: [] },
  external_communication: "block" as const,
  credentials: "block" as const,
  cloud_model_sensitive_context: "ask" as const,
  browser: "block" as const,
  browser_hosts_allow: [] as string[],
  browser_max_navigation_ms: 30_000,
  browser_max_steps_per_session: 50,
  mcp: "block" as const,
  mcp_max_concurrent_sessions: 1,
  github: "block" as const
};

function policyWith(background: WorkspacePolicy["daemon_background_actions"]): WorkspacePolicy {
  return { ...BASE_POLICY, daemon_background_actions: background };
}

describe("daemon policy gate", () => {
  it("blocks execute_mission unless allow_low_risk_automation", () => {
    const p = policyWith("draft_and_notify");
    const r = classifyJobAgainstDaemonPolicy(p, { kind: "execute_mission", missionId: "m_dummy" });
    expect(r.ok).toBe(false);
  });

  it("allows execute_mission in allow_low_risk_automation", () => {
    const p = policyWith("allow_low_risk_automation");
    const r = classifyJobAgainstDaemonPolicy(p, { kind: "execute_mission", missionId: "m_fakeidid" });
    expect(r.ok).toBe(true);
  });

  it("blocks create_mission under observe_only", () => {
    const p = policyWith("observe_only");
    const r = classifyJobAgainstDaemonPolicy(p, { kind: "create_mission", goal: "x" });
    expect(r.ok).toBe(false);
  });

  it("allows notify jobs under observe_only", () => {
    const p = policyWith("observe_only");
    const r = classifyJobAgainstDaemonPolicy(p, { kind: "notify", message: "hello" });
    expect(r.ok).toBe(true);
  });
});

describe("daemon queue replay", () => {
  it("reconciles orphaned start without finish", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    const id = createDaemonJobId();
    const job = { kind: "notify" as const, message: "x" };
    const ts = new Date().toISOString();
    const enqueue: DaemonQueueOp = { v: 1, op: "enqueue", ts, id, job };
    const start: DaemonQueueOp = { v: 1, op: "start", ts, id, job };
    await appendQueueOp(paths, enqueue);
    await appendQueueOp(paths, start);
    expect(await reconcileOrphanProcessing(paths)).toBeGreaterThanOrEqual(1);
    const replay = deriveQueueFromOps(await readAllQueueOps(paths));
    expect(replay.processing).toBeNull();
    expect(replay.pending.length >= 1).toBe(true);
  });
});

describe("daemon singleton lock", () => {
  it("blocks double acquisition until release", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    const l1 = await acquireDaemonInstance(paths, process.pid);
    await expect(acquireDaemonInstance(paths, process.pid)).rejects.toThrow(/already running/);
    await l1.release();
    const l2 = await acquireDaemonInstance(paths, process.pid);
    await l2.release();
  });
});

describe("daemon mission recovery", () => {
  it("paused running missions on startup reconcile", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const store = createMissionStore(cwd);
    const paths = resolveWorkspacePaths(cwd);
    const mission = await store.createMission({ goal: "g" });
    await store.updateMissionState(mission.id, "planning");
    await store.updateMissionState(mission.id, "running");
    const eventBus = createDaemonEventBus(paths);
    const n = await reconcileRunningMissionsOnDaemonStartup(cwd, eventBus);
    expect(n).toBe(1);
    const updated = await store.readMission(mission.id);
    expect(updated.state).toBe("paused");
  });
});

describe("daemon http", () => {
  it("rejects unauthorized and serves health when authorized", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    const queue = createDaemonQueueService(paths);
    const api = createDaemonHttpApp({
      cwd,
      bearerToken: "secret123",
      queue,
      getListenMeta: () => ({
        pid: 1,
        startedAt: new Date().toISOString(),
        uptimeMs: 0,
        host: "127.0.0.1",
        port: 17891
      })
    });

    const root = new Hono();
    root.route("/api/daemon/v1", api);

    const bad = await root.fetch(new Request("http://test/api/daemon/v1/health"));
    expect(bad.status).toBe(401);

    const good = await root.fetch(
      new Request("http://test/api/daemon/v1/health", {
        headers: { authorization: "Bearer secret123" }
      })
    );
    expect(good.status).toBe(200);
  });
});

describe("daemon trigger bridge", () => {
  it("enqueues trigger_followup to durable queue file", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    await enqueueTriggerFollowupJob(cwd, {
      triggerEventId: "e_trig_test_bridge",
      outcome: "matched",
      missionId: "m_testbridge"
    });
    const paths = resolveWorkspacePaths(cwd);
    const ops = await readAllQueueOps(paths);
    expect(ops.some((o) => o.op === "enqueue" && o.job.kind === "trigger_followup")).toBe(true);
  });
});
