#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

export const VERSION = "0.1.0";

export const PLACEHOLDER_COMMANDS = [
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

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CliIo {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
}

const intro = [
  "Narthynx is a local-first Mission Agent OS.",
  "An AI agent that runs missions, not chats.",
  "",
  "The interactive mission runtime is not implemented yet in Phase 0.",
  "Run `narthynx --help` to see the bootstrap command surface."
].join("\n");

function notImplementedMessage(commandName: string): string {
  return [
    `Command "narthynx ${commandName}" is not implemented in Phase 0.`,
    "Phase 0 only provides the CLI foundation, help, version, tests, and open-source project metadata."
  ].join("\n");
}

export function createProgram(io: CliIo): Command {
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
      "Phase 0 status:",
      "  The mission runtime, workspace init, ledgers, approvals, and replay are intentionally not implemented yet.",
      "  Placeholder commands fail honestly until their build phases land."
    ].join("\n")
  );

  program.action(() => {
    io.writeOut(`${intro}\n`);
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

export async function runCli(argv: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  const program = createProgram({
    writeOut: (message) => {
      stdout += message;
    },
    writeErr: (message) => {
      stderr += message;
    }
  });

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
    init: "Initialize a local .narthynx workspace. (Phase 1)",
    mission: "Create a mission from a natural-language goal. (Phase 2)",
    missions: "List persisted missions. (Phase 2)",
    open: "Open a persisted mission summary. (Phase 2)",
    approve: "Approve a queued action. (Phase 6)",
    pause: "Pause a mission. (Phase 2)",
    resume: "Resume a mission. (Phase 2)",
    replay: "Replay a mission ledger. (Phase 9)",
    doctor: "Run workspace health checks. (Phase 1)"
  };

  return descriptions[commandName];
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
