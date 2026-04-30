#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import { doctorWorkspace, initWorkspace, resolveWorkspacePaths } from "../config/workspace";
import { runInteractiveSession } from "./interactive";
import { createApprovalStore } from "../missions/approvals";
import { createCheckpointStore } from "../missions/checkpoints";
import { createReplayService } from "../missions/replay";
import { createReportService } from "../missions/reports";
import { createMissionStore, missionFilePath } from "../missions/store";
import { createToolRegistry } from "../tools/registry";
import { createToolRunner } from "../tools/runner";

export const VERSION = "0.1.0";

export const CLI_COMMANDS = [
  "init",
  "mission",
  "missions",
  "open",
  "plan",
  "timeline",
  "tools",
  "tool",
  "approve",
  "rewind",
  "report",
  "pause",
  "resume",
  "replay",
  "doctor"
] as const;

export const PLACEHOLDER_COMMANDS = CLI_COMMANDS.filter(
  (name): name is Exclude<
    (typeof CLI_COMMANDS)[number],
    | "init"
    | "mission"
    | "missions"
    | "open"
    | "plan"
    | "timeline"
    | "tools"
    | "tool"
    | "approve"
    | "rewind"
    | "report"
    | "replay"
    | "doctor"
  > =>
    name !== "init" &&
    name !== "mission" &&
    name !== "missions" &&
    name !== "open" &&
    name !== "plan" &&
    name !== "timeline" &&
    name !== "tools" &&
    name !== "tool" &&
    name !== "approve" &&
    name !== "rewind" &&
    name !== "report" &&
    name !== "replay" &&
    name !== "doctor"
);

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  cwd?: string;
  interactiveInput?: string[];
}

interface CliIo {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
}

const intro = [
  "Narthynx is a local-first Mission Agent OS.",
  "An AI agent that runs missions, not chats.",
  "",
  "`narthynx init`, `doctor`, `mission`, `missions`, `open`, `plan`, `timeline`, `tools`, `tool`, `approve`, `rewind`, `report`, and `replay` are available in Phase 9.",
  "Run `narthynx` in a terminal to open Phase 10 interactive mode.",
  "Mission execution is not implemented yet."
].join("\n");

function notImplementedMessage(commandName: string): string {
  return [
    `Command "narthynx ${commandName}" is not implemented in Phase 10.`,
    "Phase 10 provides interactive slash commands over the persisted mission runtime."
  ].join("\n");
}

export function createProgram(io: CliIo, options: CliOptions = {}): Command {
  const cwd = options.cwd ?? process.cwd();
  const missionStore = createMissionStore(cwd);
  const approvalStore = createApprovalStore(cwd);
  const checkpointStore = createCheckpointStore(cwd);
  const reportService = createReportService(cwd);
  const replayService = createReplayService(cwd);
  const toolRegistry = createToolRegistry();
  const toolRunner = createToolRunner({ cwd, registry: toolRegistry });
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
      "Phase 10 status:",
      "  Workspace init, missions, ledgers, plan graphs, typed tools, approval gates, filesystem writes, checkpoints, reports, replay, and interactive slash commands are implemented.",
      "  Mission execution still fails honestly until its build phase lands."
    ].join("\n")
  );

  program.action(async () => {
    if (options.interactiveInput) {
      const result = await runInteractiveSession({
        cwd,
        inputLines: options.interactiveInput,
        io
      });
      process.exitCode = result.exitCode;
      return;
    }

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
    .action(async (goalParts: string[]) => {
      const goal = goalParts.join(" ").trim();

      if (goal.length === 0) {
        io.writeErr("Mission goal is required.\nUsage: narthynx mission \"Prepare my launch checklist\"\n");
        process.exitCode = 1;
        return;
      }

      try {
        const mission = await missionStore.createMission({ goal });
        const paths = resolveWorkspacePaths(cwd);

        io.writeOut("Mission created\n");
        io.writeOut(`id: ${mission.id}\n`);
        io.writeOut(`title: ${mission.title}\n`);
        io.writeOut(`state: ${mission.state}\n`);
        io.writeOut(`path: ${missionFilePath(paths.missionsDir, mission.id)}\n`);
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("missions")
    .description("List persisted missions. (Phase 2)")
    .action(async () => {
      try {
        const missions = await missionStore.listMissions();

        if (missions.length === 0) {
          io.writeOut("No missions found.\n");
          return;
        }

        io.writeOut("Missions\n");
        for (const mission of missions) {
          io.writeOut(`${mission.id}  ${mission.state}  ${mission.createdAt}  ${mission.title}\n`);
        }
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("open")
    .description("Open a persisted mission summary. (Phase 2)")
    .argument("<id>", "Mission ID")
    .action(async (id: string) => {
      try {
        const mission = await missionStore.readMission(id);
        const paths = resolveWorkspacePaths(cwd);

        io.writeOut(`Mission ${mission.id}\n`);
        io.writeOut(`title: ${mission.title}\n`);
        io.writeOut(`goal: ${mission.goal}\n`);
        io.writeOut(`state: ${mission.state}\n`);
        io.writeOut("success criteria:\n");
        for (const criterion of mission.successCriteria) {
          io.writeOut(`  - ${criterion}\n`);
        }
        io.writeOut(`risk: ${mission.riskProfile.level} (${mission.riskProfile.reasons.join("; ")})\n`);
        io.writeOut(`created: ${mission.createdAt}\n`);
        io.writeOut(`updated: ${mission.updatedAt}\n`);
        io.writeOut(`path: ${missionFilePath(paths.missionsDir, mission.id)}\n`);
        io.writeOut(`plan: narthynx plan ${mission.id}\n`);
        io.writeOut(`report: narthynx report ${mission.id}\n`);
        io.writeOut(`timeline: narthynx timeline ${mission.id}\n`);
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("plan")
    .description("Show or create a mission plan graph. (Phase 4)")
    .argument("<id>", "Mission ID")
    .action(async (id: string) => {
      try {
        const graph = await missionStore.ensureMissionPlanGraph(id);

        io.writeOut(`Plan for ${id}\n`);
        for (const [index, node] of graph.nodes.entries()) {
          io.writeOut(`${index + 1}. [${node.type}] ${node.title} - ${node.status}\n`);
        }
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("timeline")
    .description("Show a mission action ledger. (Phase 3)")
    .argument("<id>", "Mission ID")
    .action(async (id: string) => {
      try {
        await missionStore.readMission(id);
        const events = await missionStore.readMissionLedger(id, { allowMissing: true });

        if (events.length === 0) {
          io.writeOut(`No ledger events found for mission ${id}.\n`);
          return;
        }

        io.writeOut(`Timeline for ${id}\n`);
        for (const [index, event] of events.entries()) {
          io.writeOut(`${index + 1}. ${event.timestamp}  ${event.type}  ${event.summary}\n`);
        }
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("tools")
    .description("List registered typed tools. (Phase 5)")
    .action(() => {
      io.writeOut("Tools\n");
      for (const tool of toolRegistry.list()) {
        io.writeOut(
          `${tool.name}  risk=${tool.riskLevel}  sideEffect=${tool.sideEffect}  approval=${tool.requiresApproval ? "yes" : "no"}\n`
        );
      }
    });

  program
    .command("tool")
    .description("Run a typed diagnostic tool for a mission. (Phase 5)")
    .argument("<mission-id>", "Mission ID")
    .argument("<tool-name>", "Tool name")
    .requiredOption("--input <json>", "Tool input JSON")
    .action(async (missionId: string, toolName: string, commandOptions: { input: string }) => {
      let input: unknown;

      try {
        input = JSON.parse(commandOptions.input);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid JSON";
        io.writeErr(`Invalid --input JSON: ${message}\n`);
        process.exitCode = 1;
        return;
      }

      try {
        const result = await toolRunner.runTool({
          missionId,
          toolName,
          input
        });

        if (!result.ok) {
          io.writeErr(`${result.message}\n`);
          process.exitCode = 1;
          return;
        }

        io.writeOut(`${JSON.stringify(result.output, null, 2)}\n`);
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("approve")
    .description("List, approve, or deny queued tool approvals. (Phase 6)")
    .argument("[approval-id]", "Approval ID")
    .option("--deny", "Deny the approval instead of approving it")
    .option("--reason <text>", "Decision reason")
    .action(async (approvalId: string | undefined, commandOptions: { deny?: boolean; reason?: string }) => {
      try {
        if (!approvalId) {
          const approvals = await approvalStore.listPendingApprovals();
          if (approvals.length === 0) {
            io.writeOut("No pending approvals.\n");
            return;
          }

          io.writeOut("Pending approvals\n");
          for (const approval of approvals) {
            io.writeOut(
              `${approval.id}  mission=${approval.missionId}  tool=${approval.toolName}  risk=${approval.riskLevel}  status=${approval.status}\n`
            );
            io.writeOut(`  ${approval.prompt.split(/\r?\n/)[0]}\n`);
          }
          return;
        }

        const decision = commandOptions.deny ? "denied" : "approved";
        const approval = await approvalStore.decideApproval(approvalId, decision, commandOptions.reason);
        io.writeOut(`Approval ${approval.status}: ${approval.id}\n`);
        io.writeOut(`mission: ${approval.missionId}\n`);
        io.writeOut(`tool: ${approval.toolName}\n`);
        if (approval.status === "approved") {
          const continuation = await toolRunner.runApprovedTool(approval.id);
          if (continuation.ok) {
            io.writeOut("Approved action executed.\n");
            if (continuation.checkpointId) {
              io.writeOut(`checkpoint: ${continuation.checkpointId}\n`);
            }
            io.writeOut(`${JSON.stringify(continuation.output, null, 2)}\n`);
            return;
          }

          io.writeOut(`${continuation.message}\n`);
          if (approval.toolName === "filesystem.write") {
            process.exitCode = 1;
          }
        } else {
          io.writeOut("Recorded denial. The action was not executed.\n");
        }
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("rewind")
    .description("Restore a filesystem checkpoint. (Phase 7)")
    .argument("<mission-id>", "Mission ID")
    .argument("<checkpoint-id>", "Checkpoint ID")
    .action(async (missionId: string, checkpointId: string) => {
      try {
        await missionStore.readMission(missionId);
        const result = await checkpointStore.rewindCheckpoint(missionId, checkpointId);
        io.writeOut(`Checkpoint rewound: ${result.checkpoint.id}\n`);
        io.writeOut(`path: ${result.checkpoint.targetPath}\n`);
        io.writeOut(`file rollback: ${result.fileRollback ? "yes" : "no"}\n`);
        io.writeOut(`${result.message}\n`);
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("report")
    .description("Generate a deterministic mission report artifact. (Phase 8)")
    .argument("<mission-id>", "Mission ID")
    .action(async (missionId: string) => {
      try {
        const result = await reportService.generateMissionReport(missionId);
        io.writeOut(`${result.regenerated ? "Report regenerated" : "Report created"}\n`);
        io.writeOut(`artifact: ${result.artifact.id}\n`);
        io.writeOut(`path: ${result.path}\n`);
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("replay")
    .description("Replay a mission ledger as a human-readable mission story. (Phase 9)")
    .argument("<mission-id>", "Mission ID")
    .action(async (missionId: string) => {
      try {
        io.writeOut(await replayService.renderMissionReplay(missionId));
      } catch (error) {
        writeCliError(io, error);
      }
    });

  for (const commandName of PLACEHOLDER_COMMANDS) {
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
    pause: "Pause a mission. (Phase 2)",
    resume: "Resume a mission. (Phase 2)"
  };

  return descriptions[commandName];
}

function writeCliError(io: CliIo, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown failure";
  io.writeErr(`${message}\n`);
  process.exitCode = 1;
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
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    const result = await runInteractiveSession();
    process.exitCode = result.exitCode;
  } else {
    const result = await runCli(argv);
    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    process.exitCode = result.exitCode;
  }
}
