import { mkdir, appendFile, readFile } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";
import { createDaemonJobId } from "../utils/ids";

import type { DaemonJobPayload, DaemonQueueOp } from "./schema";
import { daemonQueueOpSchema } from "./schema";

/** Hard cap pending jobs surfaced for backpressure — extra enqueue calls fail closed. */
export const MAX_PENDING_DAEMON_JOBS = 512;

interface InternalJob {
  id: string;
  job: DaemonJobPayload;
  correlationId?: string;
}

export interface QueueReplayState {
  pending: InternalJob[];
  processing: InternalJob | null;
  finishedCount: number;
}

/** Replay durable queue ops to derive pending/processing snapshot. */
export function deriveQueueFromOps(ops: DaemonQueueOp[]): QueueReplayState {
  const pendingList: InternalJob[] = [];
  let processing: InternalJob | null = null;
  let finishedCount = 0;

  const finishedIds = new Set<string>();
  const pendingIds = new Set<string>();

  for (const raw of ops) {
    switch (raw.op) {
      case "enqueue": {
        pendingList.push({ id: raw.id, job: raw.job, correlationId: raw.correlationId });
        pendingIds.add(raw.id);
        break;
      }
      case "start": {
        const idx = pendingList.findIndex((j) => j.id === raw.id);
        if (idx >= 0) {
          pendingList.splice(idx, 1);
        }
        pendingIds.delete(raw.id);
        processing = { id: raw.id, job: raw.job };
        break;
      }
      case "finish": {
        if (processing?.id === raw.id) {
          processing = null;
        }
        const pi = pendingList.findIndex((j) => j.id === raw.id);
        if (pi >= 0) {
          pendingList.splice(pi, 1);
        }
        pendingIds.delete(raw.id);
        if (!finishedIds.has(raw.id)) {
          finishedIds.add(raw.id);
          finishedCount += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  return { pending: pendingList, processing, finishedCount };
}

export async function readAllQueueOps(paths: WorkspacePaths): Promise<DaemonQueueOp[]> {
  let raw: string;
  try {
    raw = await readFile(paths.daemonQueueFile, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const out: DaemonQueueOp[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      out.push(daemonQueueOpSchema.parse(JSON.parse(t)));
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

export async function appendQueueOp(paths: WorkspacePaths, op: DaemonQueueOp): Promise<void> {
  await mkdir(paths.daemonDir, { recursive: true });
  await appendFile(paths.daemonQueueFile, `${JSON.stringify(op)}\n`, "utf8");
}

export interface DaemonQueueService {
  snapshot(): Promise<QueueReplayState>;
  enqueue(job: DaemonJobPayload, correlationId?: string): Promise<{ id: string }>;
}

export function createDaemonQueueService(paths: WorkspacePaths): DaemonQueueService {
  return {
    async snapshot(): Promise<QueueReplayState> {
      const ops = await readAllQueueOps(paths);
      return deriveQueueFromOps(ops);
    },

    async enqueue(job, correlationId) {
      const snap = deriveQueueFromOps(await readAllQueueOps(paths));
      if (snap.pending.length + (snap.processing ? 1 : 0) >= MAX_PENDING_DAEMON_JOBS) {
        throw new Error(`Daemon queue depth exceeded (${MAX_PENDING_DAEMON_JOBS}).`);
      }
      const id = createDaemonJobId();
      const now = new Date().toISOString();
      await appendQueueOp(paths, {
        v: 1,
        op: "enqueue",
        ts: now,
        id,
        job,
        correlationId
      });
      return { id };
    }
  };
}

/** If the last durable op for a job id is `start` without a later `finish`, fail-close the claim and re-queue. */
export async function reconcileOrphanProcessing(paths: WorkspacePaths): Promise<number> {
  const ops = await readAllQueueOps(paths);
  const state = deriveQueueFromOps(ops);
  if (!state.processing) {
    return 0;
  }
  const orphanId = state.processing.id;

  let lastStartIndex = -1;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.op === "start" && op.id === orphanId) {
      lastStartIndex = i;
      break;
    }
  }
  if (lastStartIndex < 0) {
    return 0;
  }
  const tail = ops.slice(lastStartIndex + 1);
  const hasFinish = tail.some((o) => o.op === "finish" && o.id === orphanId);
  if (hasFinish) {
    return 0;
  }

  const now = new Date().toISOString();
  await appendQueueOp(paths, {
    v: 1,
    op: "finish",
    ts: now,
    id: orphanId,
    ok: false,
    detail: "recovery: interrupted job before finish — re-queued"
  });
  await appendQueueOp(paths, {
    v: 1,
    op: "enqueue",
    ts: now,
    id: createDaemonJobId(),
    job: state.processing.job,
    correlationId: "recovery_requeue"
  });
  return 1;
}
