import { spawn } from "node:child_process";

function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 5000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", () => {
      clearTimeout(t);
      resolve({ code: null, stdout: "", stderr: Buffer.concat(err).toString("utf8") });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8")
      });
    });
  });
}

/** Returns true when `relativePath` is tracked in the repo (POSIX-style path segments). */
export async function gitPathIsTracked(cwd: string, relativePath: string): Promise<boolean> {
  const r = await runGit(cwd, ["ls-files", "-z", "--", relativePath]);
  if (r.code !== 0) {
    return false;
  }
  return r.stdout.includes("\0") || r.stdout.trim().length > 0;
}

/**
 * Produce a bounded `git diff` for a tracked path relative to cwd (workspace root).
 */
export async function tryGitDiffForTrackedPath(
  cwd: string,
  relativePath: string,
  maxBytes: number
): Promise<string | undefined> {
  const tracked = await gitPathIsTracked(cwd, relativePath);
  if (!tracked) {
    return undefined;
  }
  const r = await runGit(cwd, ["diff", "--", relativePath]);
  if (r.code !== null && r.code !== 0) {
    return undefined;
  }
  const body = r.stdout.trim();
  if (!body) {
    return "";
  }
  if (body.length <= maxBytes) {
    return body;
  }
  return `${body.slice(0, maxBytes)}\n… [git diff truncated to ${maxBytes} chars]\n`;
}
