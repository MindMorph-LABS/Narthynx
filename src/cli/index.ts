#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import { doctorWorkspace, initWorkspace } from "../config/workspace";

export const VERSION = "0.1.0";

export const CLI_COMMANDS = [
  "init",
  "mission",
  "missions",
  "open",
  "approve",
  "pause",
  "resume",
  "replay",
  "doctor"
] as const;

export const PLACEHOLDER_COMMANDS = CLI_COMMANDS.filter(
  (name): name is Exclude<(typeof CLI_COMMANDS)[number], "init" | "doctor"> =>
    name !== "init" && name !== "doctor"
);

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  cwd?: string;
}

interface CliIo {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
}

const intro = [
  "Narthynx is a local-first Mission Agent OS.",
  "An AI agent that runs missions, not chats.",
  "",
  "`narthynx init` and `narthynx doctor` are available in Phase 1.",
  "The mission runtime is not implemented yet."
].join("\n");

function notImplementedMessage(commandName: string): string {
  return [
    `Command "narthynx ${commandName}" is not implemented in Phase 1.`,
    "Phase 1 provides workspace initialization and doctor checks. Mission runtime behavior starts in later phases."
  ].join("\n");
}

export function createProgram(io: CliIo, options: CliOptions = {}): Command {
  const cwd = options.cwd ?? process.cwd();
  const program = new Command();

  program
    .name("narthynx")
    .description("Narthynx - a local-first Mission Agent OS.")
    .version(VERSION, "-v, --version", "Print the Narthynx version.")
    .configureOutput({
      writeOut: io.writeOut,
      writeErr: io.writeErr
    })
    .exitOverride();

  program.addHelpText(
    "after",
    [
      "",
      "Phase 1 status:",
      "  Workspace init and doctor checks are implemented.",
      "  Mission creation, ledgers, approvals, replay, and execution still fail honestly until their build phases land."
    ].join("\n")
  );

  program.action(() => {
    io.writeOut(`${intro}\n`);
  });

  program
    .command("init")
    .description("Initialize a local .narthynx workspace. (Phase 1)")
    .action(async () => {
      const result = await initWorkspace(cwd);

      io.writeOut("Narthynx workspace init\n");
      writePathList(io, "created", result.created);
      writePathList(io, "preserved", result.preserved);

      if (result.failed.length > 0) {
        writePathList(io, "failed", result.failed, "err");
        io.writeErr("Workspace init failed. State was preserved where possible.\n");
        process.exitCode = 1;
        return;
      }

      io.writeOut("Workspace is ready.\n");
    });

  program
    .command("doctor")
    .description("Run workspace health checks. (Phase 1)")
    .action(async () => {
      const result = await doctorWorkspace(cwd);

      io.writeOut("Narthynx doctor\n");
      for (const check of result.checks) {
        io.writeOut(`${check.ok ? "ok" : "fail"}  ${check.name}: ${check.message}\n`);
      }

      if (!result.ok) {
        io.writeErr("Workspace is not healthy. Run: narthynx init\n");
        process.exitCode = 1;
        return;
      }

      io.writeOut("Workspace is healthy.\n");
    });

  program
    .command("mission")
    .description("Create a mission from a natural-language goal. (Phase 2)")
    .argument("[goal...]", "Mission goal")
    .action(() => {
      io.writeErr(`${notImplementedMessage("mission")}\n`);
      process.exitCode = 1;
    });

  const otherPlaceholderCommands = PLACEHOLDER_COMMANDS.filter(
    (name): name is Exclude<(typeof PLACEHOLDER_COMMANDS)[number], "mission"> => name !== "mission"
  );

  for (const commandName of otherPlaceholderCommands) {
    program
      .command(commandName)
      .description(placeholderDescription(commandName))
      .argument("[args...]", "Command arguments reserved for later phases")
      .action(() => {
        io.writeErr(`${notImplementedMessage(commandName)}\n`);
        process.exitCode = 1;
      });
  }

  return program;
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  const program = createProgram(
    {
      writeOut: (message) => {
        stdout += message;
      },
      writeErr: (message) => {
        stderr += message;
      }
    },
    options
  );

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return {
        exitCode: error.exitCode,
        stdout,
        stderr
      };
    }

    throw error;
  }

  const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = originalExitCode;

  return {
    exitCode,
    stdout,
    stderr
  };
}

function placeholderDescription(commandName: (typeof PLACEHOLDER_COMMANDS)[number]): string {
  const descriptions: Record<(typeof PLACEHOLDER_COMMANDS)[number], string> = {
    mission: "Create a mission from a natural-language goal. (Phase 2)",
    missions: "List persisted missions. (Phase 2)",
    open: "Open a persisted mission summary. (Phase 2)",
    approve: "Approve a queued action. (Phase 6)",
    pause: "Pause a mission. (Phase 2)",
    resume: "Resume a mission. (Phase 2)",
    replay: "Replay a mission ledger. (Phase 9)"
  };

  return descriptions[commandName];
}

function writePathList(io: CliIo, label: string, paths: string[], stream: "out" | "err" = "out"): void {
  if (paths.length === 0) {
    return;
  }

  const write = stream === "out" ? io.writeOut : io.writeErr;
  write(`${label}:\n`);
  for (const pathValue of paths) {
    write(`  ${pathValue}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}
