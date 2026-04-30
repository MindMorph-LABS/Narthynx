import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput, stderr as defaultError } from "node:process";
import type { Readable, Writable } from "node:stream";

import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { createMissionStore } from "../missions/store";
import type { Mission } from "../missions/schema";
import { dispatchSlashCommand, parseShellShortcut, parseSlashCommand } from "./slash-commands";
import { renderInteractiveWelcome, renderPrompt, renderStatusLine } from "./renderer";

export const INTERACTIVE_INTERRUPT = "\u0003";

export interface InteractiveIo {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
}

export interface InteractiveSessionOptions {
  cwd?: string;
  inputLines?: string[];
  io?: InteractiveIo;
  input?: Readable;
  output?: Writable;
}

export interface InteractiveSessionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  currentMissionId?: string;
}

export async function runInteractiveSession(options: InteractiveSessionOptions = {}): Promise<InteractiveSessionResult> {
  const cwd = options.cwd ?? process.cwd();
  let stdout = "";
  let stderr = "";
  const output = options.output ?? defaultOutput;
  const errorOutput = defaultError;
  const captureOnly = Boolean(options.inputLines);
  const io =
    options.io ??
    ({
      writeOut(message) {
        stdout += message;
        if (!captureOnly) {
          output.write(message);
        }
      },
      writeErr(message) {
        stderr += message;
        if (!captureOnly) {
          errorOutput.write(message);
        }
      }
    } satisfies InteractiveIo);
  const session: InteractiveRuntime = {
    cwd,
    currentMissionId: undefined,
    exitCode: 0
  };

  if (options.inputLines) {
    await runScriptedSession(options.inputLines, session, io);
  } else {
    await runReadlineSession(session, io, options.input ?? defaultInput, options.output ?? defaultOutput);
  }

  return {
    exitCode: session.exitCode,
    stdout,
    stderr,
    currentMissionId: session.currentMissionId
  };
}

interface InteractiveRuntime {
  cwd: string;
  currentMissionId?: string;
  exitCode: number;
}

async function runScriptedSession(lines: string[], session: InteractiveRuntime, io: InteractiveIo): Promise<void> {
  io.writeOut(`${renderInteractiveWelcome()}\n`);

  for (const line of lines) {
    if (line === INTERACTIVE_INTERRUPT) {
      io.writeOut("Interrupted. Mission state is persisted; no interactive command was running.\n");
      return;
    }

    await writeStatus(session, io);
    io.writeOut(renderPrompt(session.currentMissionId));
    io.writeOut(`${line}\n`);

    const shouldExit = await handleInteractiveLine(line, session, io);
    if (shouldExit) {
      return;
    }
  }
}

async function runReadlineSession(
  session: InteractiveRuntime,
  io: InteractiveIo,
  input: Readable,
  output: Writable
): Promise<void> {
  const readline = createInterface({
    input,
    output,
    terminal: true
  });
  let interrupted = false;

  readline.on("SIGINT", () => {
    interrupted = true;
    readline.close();
  });

  io.writeOut(`${renderInteractiveWelcome()}\n`);

  try {
    while (!interrupted) {
      await writeStatus(session, io);
      const line = await readline.question(renderPrompt(session.currentMissionId)).catch((error: unknown) => {
        if (interrupted) {
          return undefined;
        }
        throw error;
      });

      if (line === undefined) {
        break;
      }

      const shouldExit = await handleInteractiveLine(line, session, io);
      if (shouldExit) {
        break;
      }
    }
  } finally {
    readline.close();
  }

  if (interrupted) {
    io.writeOut("Interrupted. Mission state is persisted; no interactive command was running.\n");
  }
}

async function handleInteractiveLine(line: string, session: InteractiveRuntime, io: InteractiveIo): Promise<boolean> {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return false;
  }

  if (trimmed.startsWith("!")) {
    try {
      const shellInput = parseShellShortcut(trimmed);
      return await dispatchInteractiveCommand(
        {
          raw: trimmed,
          name: "tool",
          args: ["shell.run", "--input", JSON.stringify(shellInput)]
        },
        session,
        io
      );
    } catch (error) {
      session.exitCode = 1;
      const message = error instanceof Error ? error.message : "Unknown shell shortcut failure";
      io.writeErr(`${message}\n`);
      return false;
    }
  }

  if (trimmed.startsWith("@")) {
    io.writeOut("Context attachment shortcuts are reserved for a future context workflow and were not applied.\n");
    return false;
  }

  if (trimmed.startsWith("#")) {
    io.writeOut("Mission memory shortcuts are reserved for a future memory workflow and were not written.\n");
    return false;
  }

  if (!trimmed.startsWith("/")) {
    io.writeErr("Interactive input must be a slash command. Type /help for commands.\n");
    session.exitCode = 1;
    return false;
  }

  try {
    return await dispatchInteractiveCommand(parseSlashCommand(trimmed), session, io);
  } catch (error) {
    session.exitCode = 1;
    const message = error instanceof Error ? error.message : "Unknown interactive failure";
    io.writeErr(`${message}\n`);
    return false;
  }
}

async function dispatchInteractiveCommand(
  command: ReturnType<typeof parseSlashCommand>,
  session: InteractiveRuntime,
  io: InteractiveIo
): Promise<boolean> {
  const result = await dispatchSlashCommand(command, {
    cwd: session.cwd,
    currentMissionId: session.currentMissionId
  });
  session.currentMissionId = result.currentMissionId;
  io.writeOut(`${ensureTrailingNewline(result.output)}`);
  return result.exit;
}

async function writeStatus(session: InteractiveRuntime, io: InteractiveIo): Promise<void> {
  const paths = resolveWorkspacePaths(session.cwd);
  const policy = await loadWorkspacePolicy(paths.policyFile);
  const mission = await readCurrentMission(session.cwd, session.currentMissionId);

  io.writeOut(
    `${renderStatusLine({
      policyMode: policy.ok ? policy.value.mode : undefined,
      mission
    })}\n`
  );
}

async function readCurrentMission(cwd: string, currentMissionId: string | undefined): Promise<Mission | undefined> {
  if (!currentMissionId) {
    return undefined;
  }

  return createMissionStore(cwd)
    .readMission(currentMissionId)
    .catch(() => undefined);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
