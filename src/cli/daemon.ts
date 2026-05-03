import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Command } from "commander";

import { doctorWorkspace, resolveWorkspacePaths } from "../config/workspace";
import { readDaemonPid, isPidRunning } from "../daemon/process-manager";
import { resolveDaemonPort, runDaemonForeground, stopDaemonForWorkspace } from "../daemon/run";
import { resolveDaemonAuthToken } from "../daemon/token";

interface CliIo {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
}

function cliEntryBinary(): string {
  const a = process.argv[1];
  if (!a || a.trim().length === 0) {
    throw new Error("Missing CLI entry (process.argv[1]).");
  }
  return path.resolve(a);
}

export function registerDaemonCommands(program: Command, io: CliIo, cwd: string): void {
  const daemonCmd = program.command("daemon").description("Always-on localhost daemon (Frontier F16). See docs/daemon.md.");

  daemonCmd
    .command("start")
    .description("Start the daemon (detached subprocess unless --foreground).")
    .option("--foreground", "Run in the foreground (this terminal)")
    .option("-p, --port <port>", "HTTP API port")
    .option("--host <address>", "Bind address", "127.0.0.1")
    .option("--danger-listen-on-lan", "Bind 0.0.0.0 — exposes daemon HTTP to LAN", false)
    .action(async (opts: { foreground?: boolean; port?: string; host?: string; dangerListenOnLan?: boolean }) => {
      try {
        const doctor = await doctorWorkspace(cwd);
        if (!doctor.ok) {
          io.writeErr("Workspace is not healthy. Run: narthynx init\n");
          process.exitCode = 1;
          return;
        }

        const portParsed =
          opts.port !== undefined && opts.port.trim().length > 0 ? Number(opts.port) : resolveDaemonPort();
        if (!Number.isInteger(portParsed) || portParsed < 1 || portParsed > 65535) {
          throw new Error("Invalid --port (use 1-65535).");
        }

        const bindHost = (opts.host ?? "127.0.0.1").trim();
        if ((opts.dangerListenOnLan ?? false) === true) {
          io.writeErr(
            "WARNING: --danger-listen-on-lan binds 0.0.0.0 — anyone on your LAN may reach the daemon HTTP API.\n\n"
          );
        }

        const paths = resolveWorkspacePaths(cwd);

        if (opts.foreground) {
          const { token, wroteFile } = await resolveDaemonAuthToken(paths);
          io.writeOut("Narthynx daemon (foreground)\n");
          io.writeOut(`Bearer token:\n${token}\n`);
          if (wroteFile) {
            io.writeOut("Token saved to .narthynx/daemon/token (override with NARTHYNX_DAEMON_TOKEN).\n");
          }
          const displayHost = opts.dangerListenOnLan ? "127.0.0.1" : bindHost;
          io.writeOut(`Listening on http://${displayHost}:${portParsed}/api/daemon/v1\n`);
          io.writeOut("Ctrl+C to stop.\n");
          await runDaemonForeground({
            cwd,
            port: portParsed,
            host: bindHost,
            dangerListenOnLan: opts.dangerListenOnLan === true
          });
          return;
        }

        let entry: string;
        try {
          entry = cliEntryBinary();
        } catch {
          io.writeErr("Cannot fork daemon: unresolved CLI entry.\nUse: pnpm narthynx daemon start --foreground\n");
          process.exitCode = 1;
          return;
        }

        const args = ["daemon", "start", "--foreground", "--host", bindHost, "--port", String(portParsed)];
        if ((opts.dangerListenOnLan ?? false) === true) {
          args.push("--danger-listen-on-lan");
        }

        const child = spawn(process.execPath, [entry, ...args], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          cwd: path.resolve(cwd),
          env: {
            ...process.env,
            NARTHYNX_DAEMON_PORT: String(portParsed),
            NARTHYNX_DAEMON_HOST: opts.dangerListenOnLan === true ? "0.0.0.0" : bindHost
          }
        });
        child.unref();
        io.writeOut(`Daemon subprocess spawned (pid ${child.pid}).\n`);
        io.writeOut("See docs/daemon.md for Bearer token and API routes.\n");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        io.writeErr(`${msg}\n`);
        process.exitCode = 1;
      }
    });

  daemonCmd
    .command("stop")
    .description("Send SIGTERM to the daemon supervisee PID (best effort).")
    .action(async () => {
      const res = await stopDaemonForWorkspace(cwd);
      io.writeOut(`${res.message}\n`);
      const benign = !res.stopped && (res.message.includes("Stale") || res.message.includes("not running"));
      if (!res.stopped && !benign) {
        process.exitCode = 1;
      }
    });

  daemonCmd
    .command("status")
    .description("Show daemon PID and last published status snapshot (if present).")
    .action(async () => {
      const paths = resolveWorkspacePaths(cwd);
      const pid = await readDaemonPid(paths);
      if (pid === null) {
        io.writeOut("No daemon pid file (.narthynx/daemon/daemon.pid).\n");
        return;
      }
      io.writeOut(`pid file: ${pid} (${isPidRunning(pid) ? "running" : "not running"})\n`);
      try {
        const snap = JSON.parse(await readFile(paths.daemonStatusFile, "utf8")) as Record<string, unknown>;
        io.writeOut(`${JSON.stringify(snap, null, 2)}\n`);
      } catch {
        io.writeOut("(No status snapshot yet)\n");
      }
    });

  daemonCmd
    .command("logs")
    .description("Print recent daemon log lines.")
    .option("--lines <n>", "Tail line count", "80")
    .action(async (opts: { lines: string }) => {
      const paths = resolveWorkspacePaths(cwd);
      const n = Math.max(1, Math.min(500, Number(opts.lines) || 80));
      try {
        const raw = await readFile(paths.daemonLogFile, "utf8");
        const rows = raw.split(/\r?\n/).filter(Boolean);
        io.writeOut(rows.slice(-n).join("\n") + "\n");
      } catch {
        io.writeOut("(empty or missing daemon.log)\n");
      }
    });
}
