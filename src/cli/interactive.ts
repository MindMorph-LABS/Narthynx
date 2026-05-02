import { createInterface } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput, stderr as defaultError } from "node:process";
import type { Readable, Writable } from "node:stream";

import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { createMissionExecutor } from "../agent/executor";
import { createMissionStore } from "../missions/store";
import type { Mission } from "../missions/schema";
import { readApprovalKeyChoice } from "./approval-keypress";
import { handleNaturalLanguageInstruction } from "./natural-language";
import { routeInteractiveInput } from "./input-router";
import type { InteractiveIo, Renderer } from "./renderer";
import { resolveModelLabel } from "./renderer";
import { createReadlineRenderer } from "./renderers/readline-renderer";
import { createInteractiveSessionState, type InteractiveSessionState } from "./session";
import {
  dispatchSlashCommand,
  parseSlashCommand,
  type PendingApprovalInteractive,
  type SlashCommandContext
} from "./slash-commands";
import { isSensitiveContextPath, parseAtShortcut, parseHashShortcut, parseShellShortcut } from "./shortcuts";
import { appendWorkspaceNote, workspaceNoteLooksSensitive } from "./workspace-notes";

export const INTERACTIVE_INTERRUPT = "\u0003";

export type { InteractiveIo };

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

const RESUME_HINT = "Mission state saved. Resume with: narthynx open <id> or run narthynx again.";

export async function runInteractiveSession(options: InteractiveSessionOptions = {}): Promise<InteractiveSessionResult> {
  const cwd = options.cwd ?? process.cwd();
  let stdout = "";
  let stderr = "";
  const output = options.output ?? defaultOutput;
  const errorOutput = defaultError;
  const captureOnly = Boolean(options.inputLines);
  const io: InteractiveIo =
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

  const session = createInteractiveSessionState(cwd);
  const renderer = createReadlineRenderer(io);

  if (options.inputLines) {
    await runScriptedSession(options.inputLines, session, io, renderer);
  } else {
    await runReadlineSession(session, io, renderer, options.input ?? defaultInput, options.output ?? defaultOutput);
  }

  return {
    exitCode: session.exitCode,
    stdout,
    stderr,
    currentMissionId: session.currentMissionId
  };
}

function printResumeMessage(renderer: Renderer): void {
  renderer.info(RESUME_HINT);
}

async function runScriptedSession(
  lines: string[],
  session: InteractiveSessionState,
  io: InteractiveIo,
  renderer: Renderer
): Promise<void> {
  await renderIntro(session, renderer);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === INTERACTIVE_INTERRUPT) {
      renderer.info("Interrupted. Mission state is persisted; no interactive command was running.");
      return;
    }

    await writeStatusLine(session, renderer);
    io.writeOut(`${renderer.formatPrompt(session, await readCurrentMission(session.cwd, session.currentMissionId))}`);
    io.writeOut(`${line}\n`);

    const outcome = await handleInteractiveLine(line, session, renderer);
    if (outcome.exit) {
      printResumeMessage(renderer);
      return;
    }
    if (outcome.pendingApproval) {
      await handleApprovalKeysIfTty(outcome.pendingApproval, session, renderer, undefined);
    }
  }
}

async function runReadlineSession(
  session: InteractiveSessionState,
  io: InteractiveIo,
  renderer: Renderer,
  input: Readable,
  output: Writable
): Promise<void> {
  await renderIntro(session, renderer);

  let shuttingDown = false;
  let pendingExitConfirm = false;
  let resumePrinted = false;

  const shutdownResume = (): void => {
    if (!resumePrinted) {
      resumePrinted = true;
      printResumeMessage(renderer);
    }
  };

  const rl = createInterface({
    input,
    output,
    terminal: true,
    historySize: 2000
  });

  const nextPrompt = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    const mission = await readCurrentMission(session.cwd, session.currentMissionId);
    await writeStatusLine(session, renderer, mission);
    rl.setPrompt(renderer.formatPrompt(session, mission));
    rl.prompt();
  };

  rl.on("SIGINT", () => {
    if (pendingExitConfirm) {
      pendingExitConfirm = false;
      io.writeOut("\nExit cancelled — mission state is saved. Use /exit or Ctrl+D to leave.\n");
      void nextPrompt();
      return;
    }

    if (rl.line.length > 0) {
      rl.write("\n");
      void nextPrompt();
      return;
    }

    if (session.currentMissionId) {
      pendingExitConfirm = true;
      io.writeOut("\nExit interactive shell? [y/N] ");
      return;
    }

    shuttingDown = true;
    shutdownResume();
    rl.close();
  });

  rl.on("line", async (line) => {
    if (shuttingDown) {
      return;
    }

    if (pendingExitConfirm) {
      pendingExitConfirm = false;
      if (line.trim().toLowerCase() === "y") {
        shuttingDown = true;
        shutdownResume();
        rl.close();
        return;
      }
      await nextPrompt();
      return;
    }

    const outcome = await handleInteractiveLine(line, session, renderer);
    if (outcome.exit) {
      shuttingDown = true;
      shutdownResume();
      rl.close();
      return;
    }

    if (outcome.pendingApproval) {
      await handleApprovalKeysIfTty(outcome.pendingApproval, session, renderer, input, io);
    }

    await nextPrompt();
  });

  await nextPrompt();

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      shutdownResume();
      resolve();
    });
  });
}

async function handleApprovalKeysIfTty(
  pending: PendingApprovalInteractive,
  session: InteractiveSessionState,
  renderer: Renderer,
  input: Readable | undefined,
  io?: InteractiveIo
): Promise<void> {
  if (!input?.isTTY) {
    return;
  }

  const choice = await readApprovalKeyChoice(input);
  io?.writeOut("\n");
  const executor = createMissionExecutor(session.cwd);

  if (choice === "approve") {
    const r = await dispatchSlashCommand(parseSlashCommand(`/approve ${pending.approvalId}`), slashContext(session, renderer));
    session.currentMissionId = r.currentMissionId;
  } else if (choice === "deny") {
    const r = await dispatchSlashCommand(
      parseSlashCommand(`/approve ${pending.approvalId} --deny`),
      slashContext(session, renderer)
    );
    session.currentMissionId = r.currentMissionId;
  } else if (choice === "pause") {
    try {
      const result = await executor.pauseMission(pending.missionId);
      renderer.rawBlock(result.output.trimEnd());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pause failed";
      renderer.renderError(message);
    }
  } else if (choice === "edit") {
    renderer.info("Edit-in-approval is not implemented yet. Deny with [d] or /approve --deny, then adjust your instruction.");
  }
}

function slashContext(session: InteractiveSessionState, renderer: Renderer): SlashCommandContext {
  return {
    cwd: session.cwd,
    currentMissionId: session.currentMissionId,
    session,
    renderer
  };
}

async function renderIntro(session: InteractiveSessionState, renderer: Renderer): Promise<void> {
  const paths = resolveWorkspacePaths(session.cwd);
  const policy = await loadWorkspacePolicy(paths.policyFile);
  renderer.intro({
    workspace: session.cwd,
    policyLabel: policy.ok ? policy.value.mode : `invalid (${policy.message})`,
    cockpitMode: session.cockpitMode,
    modelLabel: resolveModelLabel(),
    activeMissionId: session.currentMissionId ?? "none"
  });
  renderer.info("");
}

async function writeStatusLine(session: InteractiveSessionState, renderer: Renderer, missionOverride?: Mission): Promise<void> {
  const policy = await loadWorkspacePolicy(resolveWorkspacePaths(session.cwd).policyFile);
  const mission = missionOverride ?? (await readCurrentMission(session.cwd, session.currentMissionId));

  renderer.status({
    cockpitMode: session.cockpitMode,
    mission,
    policyMode: policy.ok ? policy.value.mode : undefined,
    modelLabel: resolveModelLabel()
  });
}

async function readCurrentMission(cwd: string, currentMissionId: string | undefined): Promise<Mission | undefined> {
  if (!currentMissionId) {
    return undefined;
  }

  return createMissionStore(cwd)
    .readMission(currentMissionId)
    .catch(() => undefined);
}

interface LineOutcome {
  exit: boolean;
  pendingApproval?: PendingApprovalInteractive;
}

async function handleInteractiveLine(line: string, session: InteractiveSessionState, renderer: Renderer): Promise<LineOutcome> {
  const routed = routeInteractiveInput(line);

  if (routed.kind === "empty") {
    return { exit: false };
  }

  if (routed.kind === "natural") {
    try {
      await handleNaturalLanguageInstruction({ text: routed.text, session, renderer });
      return { exit: false };
    } catch (error) {
      session.exitCode = 1;
      const message = error instanceof Error ? error.message : "Unknown natural language failure";
      renderer.renderError(message);
      return { exit: false };
    }
  }

  if (routed.kind === "shell") {
    try {
      const shellInput = parseShellShortcut(routed.raw);
      return await dispatchInteractiveCommand(
        {
          raw: routed.raw,
          name: "tool",
          args: ["shell.run", "--input", JSON.stringify({ command: shellInput.command, args: shellInput.args })]
        },
        session,
        renderer
      );
    } catch (error) {
      session.exitCode = 1;
      const message = error instanceof Error ? error.message : "Unknown shell shortcut failure";
      renderer.renderError(message);
      return { exit: false };
    }
  }

  if (routed.kind === "context_file") {
    try {
      const filePath = parseAtShortcut(routed.raw);
      if (isSensitiveContextPath(filePath)) {
        renderer.warn(
          `Refusing @ attach: path looks sensitive (${filePath}). Remove secrets/credentials from mission context.`
        );
        return { exit: false };
      }

      return await dispatchInteractiveCommand(
        {
          raw: routed.raw,
          name: "context",
          args: ["--file", filePath, "--reason", "interactive shortcut"]
        },
        session,
        renderer
      );
    } catch (error) {
      session.exitCode = 1;
      const message = error instanceof Error ? error.message : "Unknown context shortcut failure";
      renderer.renderError(message);
      return { exit: false };
    }
  }

  if (routed.kind === "note") {
    try {
      const note = parseHashShortcut(routed.raw);
      if (!session.currentMissionId) {
        if (workspaceNoteLooksSensitive(note)) {
          renderer.warn(
            "Warning: this note may contain secrets or credentials. It will still be saved to workspace-notes.md; prefer /mission and scoped context, and rotate any exposed credentials."
          );
        }
        const notePath = await appendWorkspaceNote(session.cwd, note);
        renderer.info(`No active mission. Note saved to workspace file:\n${notePath}`);
        return { exit: false };
      }

      return await dispatchInteractiveCommand(
        {
          raw: routed.raw,
          name: "context",
          args: ["--note", note]
        },
        session,
        renderer
      );
    } catch (error) {
      session.exitCode = 1;
      const message = error instanceof Error ? error.message : "Unknown context note failure";
      renderer.renderError(message);
      return { exit: false };
    }
  }

  try {
    return await dispatchInteractiveCommand(parseSlashCommand(routed.raw), session, renderer);
  } catch (error) {
    session.exitCode = 1;
    const message = error instanceof Error ? error.message : "Unknown interactive failure";
    renderer.renderError(message);
    return { exit: false };
  }
}

async function dispatchInteractiveCommand(
  command: ReturnType<typeof parseSlashCommand>,
  session: InteractiveSessionState,
  renderer: Renderer
): Promise<LineOutcome> {
  const result = await dispatchSlashCommand(command, slashContext(session, renderer));
  session.currentMissionId = result.currentMissionId;

  if (result.exit) {
    return { exit: true };
  }

  return {
    exit: false,
    pendingApproval: result.pendingApproval
  };
}
