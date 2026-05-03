import { mkdir, readFile, writeFile } from "node:fs/promises";

import YAML from "yaml";

import type { WorkspacePaths } from "../config/workspace";

import { scheduleFileSchema, scheduleStateSchema, type DaemonScheduleFile, type DaemonScheduleState } from "./schema";

export const DEFAULT_SCHEDULE_YAML = `${YAML.stringify({ version: 1, schedules: [] } satisfies DaemonScheduleFile)}\n`;

export async function loadDaemonSchedule(paths: WorkspacePaths): Promise<DaemonScheduleFile> {
  try {
    const raw = await readFile(paths.daemonScheduleFile, "utf8");
    const parsed = YAML.parse(raw);
    return scheduleFileSchema.parse(parsed);
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return { version: 1, schedules: [] };
    }
    throw e;
  }
}

async function loadOrInitScheduleState(paths: WorkspacePaths): Promise<DaemonScheduleState> {
  try {
    const raw = await readFile(paths.daemonScheduleStateFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return scheduleStateSchema.parse(parsed);
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return { version: 1, lastFire: {} };
    }
    throw e;
  }
}

async function persistScheduleState(paths: WorkspacePaths, state: DaemonScheduleState): Promise<void> {
  await writeFile(paths.daemonScheduleStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function maybeEnqueueScheduledJobs(
  paths: WorkspacePaths,
  enqueue: (job: DaemonScheduleFile["schedules"][number]["job"]) => Promise<{ id: string }>
): Promise<number> {
  const file = await loadDaemonSchedule(paths);
  if (file.schedules.length === 0) {
    return 0;
  }

  let state = await loadOrInitScheduleState(paths);
  const now = Date.now();
  let count = 0;

  for (const sch of file.schedules) {
    const intervalMs = sch.interval_minutes * 60_000;
    const last = state.lastFire[sch.id] ? Date.parse(state.lastFire[sch.id]) : 0;
    const since = Number.isFinite(last) ? now - last : Number.POSITIVE_INFINITY;
    if (since >= intervalMs) {
      await enqueue(sch.job);
      state = {
        ...state,
        lastFire: { ...state.lastFire, [sch.id]: new Date().toISOString() }
      };
      count += 1;
    }
  }

  if (count > 0) {
    await persistScheduleState(paths, state);
  }
  return count;
}

export async function ensureScheduleFile(paths: WorkspacePaths): Promise<void> {
  try {
    await readFile(paths.daemonScheduleFile, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      await mkdir(paths.daemonDir, { recursive: true });
      await writeFile(paths.daemonScheduleFile, DEFAULT_SCHEDULE_YAML, "utf8");
      return;
    }
    throw e;
  }
}
