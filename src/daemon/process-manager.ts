import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";

import { appendDaemonLog } from "./log";

export async function ensureDaemonDir(paths: WorkspacePaths): Promise<void> {
  await mkdir(paths.daemonDir, { recursive: true });
}

export function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readDaemonPid(paths: WorkspacePaths): Promise<number | null> {
  try {
    const raw = (await readFile(paths.daemonPidFile, "utf8")).trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

export interface DaemonInstanceLock {
  release: () => Promise<void>;
}

/**
 * Single-instance lock via exclusive `daemon.lock` creation.
 * Stale locks (dead pid) are cleared and retried once.
 */
export async function acquireDaemonInstance(paths: WorkspacePaths, currentPid: number): Promise<DaemonInstanceLock> {
  await ensureDaemonDir(paths);

  async function attempt(): Promise<DaemonInstanceLock> {
    try {
      const handle = await open(paths.daemonLockFile, "wx");
      await writeFile(paths.daemonPidFile, `${currentPid}\n`, "utf8");
      await appendDaemonLog(paths, `daemon acquired lock pid=${currentPid}`);
      return {
        release: async () => {
          try {
            await handle.close();
          } catch {
            /* ignore */
          }
          await unlink(paths.daemonLockFile).catch(() => {});
          await unlink(paths.daemonPidFile).catch(() => {});
          await appendDaemonLog(paths, `daemon released lock pid=${currentPid}`);
        }
      };
    } catch (e) {
      const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
      if (code !== "EEXIST") {
        throw e;
      }
      const existing = await readDaemonPid(paths);
      if (existing !== null && isPidRunning(existing)) {
        throw new Error(`Another Narthynx daemon is already running (pid ${existing}). Stop it first: narthynx daemon stop`);
      }
      await unlink(paths.daemonLockFile).catch(() => {});
      await unlink(paths.daemonPidFile).catch(() => {});
      await appendDaemonLog(paths, "daemon cleared stale lock");
      return attempt();
    }
  }

  return attempt();
}
