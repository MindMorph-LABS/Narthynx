import { z } from "zod";

export const daemonJobPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("notify"),
    message: z.string().min(1).max(4000),
    level: z.enum(["info", "warn", "error"]).optional()
  }),
  z.object({
    kind: z.literal("emit_event"),
    type: z.string().min(1).max(128),
    summary: z.string().min(1).max(512),
    payload: z.record(z.unknown()).optional()
  }),
  z.object({
    kind: z.literal("create_mission"),
    goal: z.string().min(1).max(16_000),
    title: z.string().max(512).optional()
  }),
  z.object({
    kind: z.literal("execute_mission"),
    missionId: z.string().regex(/^m_[a-z0-9_-]+$/)
  }),
  z.object({
    kind: z.literal("scheduled_tick"),
    scheduleId: z.string().min(1).max(256)
  }),
  z.object({
    kind: z.literal("trigger_followup"),
    triggerEventId: z.string().min(1),
    missionId: z.string().optional(),
    outcome: z.string().optional()
  })
]);

export type DaemonJobPayload = z.infer<typeof daemonJobPayloadSchema>;

const queueBase = z.object({
  ts: z.string(),
  v: z.literal(1)
});

export const daemonQueueOpSchema = z.discriminatedUnion("op", [
  queueBase.extend({
    op: z.literal("enqueue"),
    id: z.string(),
    job: daemonJobPayloadSchema,
    correlationId: z.string().optional()
  }),
  queueBase.extend({
    op: z.literal("start"),
    id: z.string(),
    job: daemonJobPayloadSchema
  }),
  queueBase.extend({
    op: z.literal("finish"),
    id: z.string(),
    ok: z.boolean(),
    detail: z.string().optional()
  })
]);

export type DaemonQueueOp = z.infer<typeof daemonQueueOpSchema>;

export const daemonEventRowSchema = z.object({
  id: z.string(),
  ts: z.string(),
  type: z.string().min(1).max(256),
  summary: z.string().min(1).max(2000),
  details: z.record(z.unknown()).optional()
});

export type DaemonEventRow = z.infer<typeof daemonEventRowSchema>;

export const daemonStatusSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int(),
  startedAt: z.string(),
  uptimeMs: z.number().nonnegative(),
  cwd: z.string(),
  api: z.object({
    host: z.string(),
    port: z.number().int(),
    basePath: z.string()
  }),
  queue: z.object({
    pending: z.number().int().nonnegative(),
    processingId: z.string().nullable(),
    completedTail: z.number().int().nonnegative()
  }),
  policy_daemon_background_actions: z.enum(["observe_only", "draft_and_notify", "allow_low_risk_automation"])
});

export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

export const scheduleFileSchema = z.object({
  version: z.literal(1),
  schedules: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        interval_minutes: z.number().int().min(1).max(10_080),
        job: daemonJobPayloadSchema
      })
    )
    .default([])
});

export type DaemonScheduleFile = z.infer<typeof scheduleFileSchema>;

export const scheduleStateSchema = z.object({
  version: z.literal(1),
  lastFire: z.record(z.string(), z.string())
});

export type DaemonScheduleState = z.infer<typeof scheduleStateSchema>;
