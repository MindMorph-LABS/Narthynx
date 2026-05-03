import { Hono } from "hono";

import { doctorWorkspace, resolveWorkspacePaths } from "../config/workspace";
import { loadWorkspacePolicy } from "../config/load";

import { readDaemonEvents } from "./event-bus";
import { classifyJobAgainstDaemonPolicy } from "./policy-gate";
import type { DaemonQueueService } from "./queue";
import { daemonJobPayloadSchema } from "./schema";

export interface DaemonListenMeta {
  pid: number;
  startedAt: string;
  uptimeMs: number;
  host: string;
  port: number;
}

export interface DaemonHttpContext {
  cwd: string;
  bearerToken: string;
  queue: DaemonQueueService;
  getListenMeta: () => DaemonListenMeta;
}

/** Simple burst guard for localhost callers (still defensive). */
function createLocalRateLimiter(maxPerMinute: number) {
  const hits: number[] = [];
  return function allow(): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    while (hits.length > 0 && now - hits[0] > windowMs) {
      hits.shift();
    }
    if (hits.length >= maxPerMinute) {
      return false;
    }
    hits.push(now);
    return true;
  };
}

export function createDaemonHttpApp(ctx: DaemonHttpContext): Hono {
  const paths = resolveWorkspacePaths(ctx.cwd);
  const rl = createLocalRateLimiter(180);

  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!rl()) {
      return c.json({ error: "Too many requests", code: "rate_limited" }, 429);
    }
    await next();
  });

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${ctx.bearerToken}`) {
      return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/health", async (c) => {
    const doc = await doctorWorkspace(ctx.cwd);
    return c.json({ ok: doc.ok, checks: doc.checks, daemon: ctx.getListenMeta() });
  });

  app.get("/status", async (c) => {
    const doc = await doctorWorkspace(ctx.cwd);
    const meta = ctx.getListenMeta();
    const pol = await loadWorkspacePolicy(paths.policyFile);
    const snap = await ctx.queue.snapshot();
    if (!pol.ok) {
      return c.json(
        {
          error: pol.message,
          code: "invalid_policy",
          doctor: doc.ok,
          daemon: meta
        },
        500
      );
    }

    const body = {
      ok: true as const,
      pid: meta.pid,
      startedAt: meta.startedAt,
      uptimeMs: meta.uptimeMs,
      cwd: paths.rootDir,
      api: {
        host: meta.host,
        port: meta.port,
        basePath: "/api/daemon/v1"
      },
      queue: {
        pending: snap.pending.length,
        processingId: snap.processing?.id ?? null,
        finishedTail: snap.finishedCount
      },
      policy_daemon_background_actions: pol.value.daemon_background_actions,
      doctor_ok: doc.ok
    };

    return c.json(body);
  });

  app.get("/queue", async (c) => {
    const snap = await ctx.queue.snapshot();
    return c.json({
      pending: snap.pending.map((p) => ({ id: p.id, job: p.job, correlationId: p.correlationId })),
      processing: snap.processing
        ? { id: snap.processing.id, job: snap.processing.job }
        : null
    });
  });

  app.post("/queue", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body", code: "invalid_json" }, 400);
    }
    const parsed = daemonJobPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.flatten(), code: "invalid_job_payload" },
        400
      );
    }

    const pol = await loadWorkspacePolicy(paths.policyFile);
    if (!pol.ok) {
      return c.json({ error: pol.message, code: "invalid_policy" }, 500);
    }

    const gate = classifyJobAgainstDaemonPolicy(pol.value, parsed.data);
    if (!gate.ok) {
      return c.json({ error: gate.reason, code: "policy_denied" }, 403);
    }

    try {
      const { id } = await ctx.queue.enqueue(parsed.data);
      return c.json({ ok: true, id }, 202);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg, code: "enqueue_failed" }, 500);
    }
  });

  app.get("/events", async (c) => {
    const since = c.req.query("since") ?? "";
    const limitRaw = c.req.query("limit") ?? "200";
    const limit = Number(limitRaw);
    const events = await readDaemonEvents(paths, {
      since: since.trim() === "" ? undefined : since.trim(),
      limit: Number.isFinite(limit) ? limit : 200
    });
    return c.json({ events });
  });

  return app;
}
