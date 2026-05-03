#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stdin } from "node:process";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import { createCostService } from "../agent/cost";
import { createMissionExecutor } from "../agent/executor";
import { createModelPlanner } from "../agent/model-planner";
import { loadContextDietConfig } from "../config/context-diet-config";
import { loadMcpConfig } from "../config/mcp-config";
import { loadWorkspacePolicy } from "../config/load";
import { doctorWorkspace, initWorkspace, resolveWorkspacePaths } from "../config/workspace";
import { runCockpitServer, resolveCockpitPort } from "../cockpit/serve";
import { runInteractiveSession } from "./interactive";
import { createApprovalStore } from "../missions/approvals";
import { createCheckpointStore } from "../missions/checkpoints";
import { createReplayService } from "../missions/replay";
import { createReportService } from "../missions/reports";
import { createMissionStore, missionFilePath } from "../missions/store";
import { createMissionContextService } from "../missions/context";
import { buildModelContextPack, pruneStaleContextEntries } from "../missions/context-diet";
import { createProofCardService } from "../missions/proof-card";
import { createMissionInputFromTemplate, listMissionTemplates } from "../missions/templates";
import { ingestTriggerEvent, replayTriggerByEventId, formatTriggersDoctorMessage } from "../triggers/engine";
import { loadTriggersConfig } from "../triggers/rules";
import { readTriggerLogLines } from "../triggers/event-log";
import { createToolRegistry } from "../tools/registry";
import { cacheEntryFresh, readMcpToolsCache } from "../tools/mcp-cache";
import { isMcpServerPolicyAllowed } from "../tools/mcp-guard";
import { createToolRunner } from "../tools/runner";

export const VERSION = "0.1.0";

export const CLI_COMMANDS = [
  "init",
  "mission",
  "missions",
  "templates",
  "open",
  "plan",
  "run",
  "context",
  "timeline",
  "tools",
  "tool",
  "approve",
  "rewind",
  "report",
  "proof",
  "cost",
  "cockpit",
  "pause",
  "resume",
  "replay",
  "doctor",
  "triggers"
] as const;

export const PLACEHOLDER_COMMANDS = CLI_COMMANDS.filter(
  (name): name is Exclude<
    (typeof CLI_COMMANDS)[number],
    | "init"
    | "mission"
    | "missions"
    | "templates"
    | "open"
    | "plan"
    | "run"
    | "context"
    | "timeline"
    | "tools"
    | "tool"
    | "approve"
    | "rewind"
    | "report"
    | "proof"
    | "cost"
    | "cockpit"
    | "pause"
    | "resume"
    | "replay"
    | "doctor"
    | "triggers"
  > =>
    name !== "init" &&
    name !== "mission" &&
    name !== "missions" &&
    name !== "templates" &&
    name !== "open" &&
    name !== "plan" &&
    name !== "run" &&
    name !== "context" &&
    name !== "timeline" &&
    name !== "tools" &&
    name !== "tool" &&
    name !== "approve" &&
    name !== "rewind" &&
    name !== "report" &&
    name !== "proof" &&
    name !== "cost" &&
    name !== "cockpit" &&
    name !== "pause" &&
    name !== "resume" &&
    name !== "replay" &&
    name !== "doctor" &&
    name !== "triggers"
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

function notImplementedMessage(commandName: string): string {
  return [
    `Command "narthynx ${commandName}" is not implemented in Phase 15.`,
    "Phase 15 provides Mission Kit primitives: templates, context diet basics, and proof cards."
  ].join("\n");
}

export function createProgram(io: CliIo, options: CliOptions = {}): Command {
  const cwd = options.cwd ?? process.cwd();
  const missionStore = createMissionStore(cwd);
  const approvalStore = createApprovalStore(cwd);
  const checkpointStore = createCheckpointStore(cwd);
  const reportService = createReportService(cwd);
  const replayService = createReplayService(cwd);
  const contextService = createMissionContextService(cwd);
  const proofCardService = createProofCardService(cwd);
  const costService = createCostService(cwd);
  const modelPlanner = createModelPlanner(cwd, { approvalStore });
  const executor = createMissionExecutor(cwd);
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
      "Phase 13 status:",
      "  Workspace init, missions, ledgers, plan graphs, typed tools, approval gates, filesystem writes, checkpoints, reports, replay, interactive slash commands, shell.run, git.diff, git.log, model provider routing, cost summaries, and the first mission executor vertical slice are implemented.",
      "Phase 15 status:",
      "  Mission templates, context diet basics, and proof cards are implemented."
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

    io.writeOut(
      "Run `narthynx` with no arguments in a terminal for the interactive mission shell. Use `narthynx --help` for one-shot subcommands.\n"
    );
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

  const mcpProgram = program.command("mcp").description("MCP connector helpers (stdio servers).");

  mcpProgram
    .command("list")
    .description("List MCP servers from .narthynx/mcp.yaml and tool-list cache status.")
    .action(async () => {
      const paths = resolveWorkspacePaths(cwd);
      const loaded = await loadMcpConfig(paths.mcpFile);
      if (!loaded.ok) {
        io.writeErr(`mcp.yaml invalid: ${loaded.message}\n`);
        process.exitCode = 1;
        return;
      }
      const policy = await loadWorkspacePolicy(paths.policyFile);
      io.writeOut("MCP servers\n");
      if (loaded.value.servers.length === 0) {
        io.writeOut("  (none configured — add .narthynx/mcp.yaml)\n");
        return;
      }
      for (const s of loaded.value.servers) {
        const polOk = policy.ok ? isMcpServerPolicyAllowed(policy.value, s.id) : false;
        const cache = await readMcpToolsCache(paths.mcpCacheDir, s.id, Number.POSITIVE_INFINITY);
        const fresh = cacheEntryFresh(cache, 5 * 60 * 1_000);
        io.writeOut(`  - ${s.id}: ${s.command} ${s.args.join(" ")}\n`);
        io.writeOut(
          `      policyAllowed: ${polOk}, mcp.policy: ${policy.ok ? policy.value.mcp : "policy.yaml invalid"}\n`
        );
        if (cache) {
          io.writeOut(`      cache: ${cache.cachedAt} (${cache.tools.length} tools, fresh=${fresh})\n`);
        } else {
          io.writeOut("      cache: (none)\n");
        }
      }
    });

  const triggers = program
    .command("triggers")
    .description("Event-to-mission triggers (declarative rules, Event Memory, dedup).");

  triggers
    .command("doctor")
    .description("Validate .narthynx/triggers.yaml.")
    .action(async () => {
      const paths = resolveWorkspacePaths(cwd);
      const loaded = await loadTriggersConfig(paths);
      if (!loaded.ok) {
        io.writeErr(`${loaded.message}\n`);
        io.writeOut(`${formatTriggersDoctorMessage(paths)}\n`);
        process.exitCode = 1;
        return;
      }
      io.writeOut(`triggers.yaml OK (${loaded.config.rules.length} rule(s))\n`);
    });

  triggers
    .command("test")
    .description("Dry-run ingest from a JSON fixture (no mission created).")
    .requiredOption("--fixture <path>", "Path to webhook JSON body")
    .option("--source <source>", "trigger source", "github")
    .option("--event <name>", "GitHub X-GitHub-Event value", "issues")
    .action(async (commandOptions: { fixture: string; source: string; event: string }) => {
      try {
        const raw = await readFile(path.resolve(cwd, commandOptions.fixture), "utf8");
        const parsedJson = JSON.parse(raw) as unknown;
        const res = await ingestTriggerEvent(cwd, {
          source: commandOptions.source as "github" | "manual" | "generic",
          rawBody: raw,
          parsedJson,
          githubEventName: commandOptions.event,
          dryRun: true
        });
        io.writeOut(`${JSON.stringify(res, null, 2)}\n`);
        if (!res.ok) {
          process.exitCode = 1;
        }
      } catch (error) {
        writeCliError(io, error);
      }
    });

  triggers
    .command("ingest")
    .description("Ingest an event payload and create missions when rules match.")
    .requiredOption("--source <source>", "github | manual | generic")
    .option("--file <path>", "Payload file (omit or `-` for stdin)")
    .option("--event <name>", "For GitHub: X-GitHub-Event value", "issues")
    .action(async (commandOptions: { source: string; file?: string; event: string }) => {
      try {
        let raw: string;
        if (!commandOptions.file || commandOptions.file === "-") {
          raw = await readStdinUtf8();
        } else {
          raw = await readFile(path.resolve(cwd, commandOptions.file), "utf8");
        }
        if (!raw.trim()) {
          throw new Error("Empty payload");
        }
        const parsedJson = JSON.parse(raw) as unknown;
        const src = commandOptions.source as "github" | "manual" | "generic";
        const res = await ingestTriggerEvent(cwd, {
          source: src,
          rawBody: raw,
          parsedJson,
          githubEventName: src === "github" ? commandOptions.event : undefined,
          dryRun: false
        });
        io.writeOut(`${JSON.stringify(res, null, 2)}\n`);
        if (!res.ok) {
          process.exitCode = 1;
        }
      } catch (error) {
        writeCliError(io, error);
      }
    });

  triggers
    .command("log")
    .description("Print trigger event log lines (JSON) within a time window.")
    .option("--hours <n>", "Only entries newer than N hours", "24")
    .action(async (commandOptions: { hours: string }) => {
      const hours = Math.max(0, Number(commandOptions.hours) || 24);
      const since = Date.now() - hours * 3600_000;
      const paths = resolveWorkspacePaths(cwd);
      const lines = await readTriggerLogLines(paths);
      for (const line of lines) {
        if (new Date(line.receivedAt).getTime() >= since) {
          io.writeOut(`${JSON.stringify(line)}\n`);
        }
      }
    });

  triggers
    .command("replay")
    .description("Re-run ingest from a stored trigger event id.")
    .argument("<eventId>", "event id from trigger log (e_trig_…) ")
    .option("--force", "Bypass dedup", false)
    .action(async (eventId: string, commandOptions: { force: boolean }) => {
      try {
        const res = await replayTriggerByEventId(cwd, eventId, { force: commandOptions.force });
        io.writeOut(`${JSON.stringify(res, null, 2)}\n`);
        if (!res.ok) {
          process.exitCode = 1;
        }
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("mission")
    .description("Create a mission from a natural-language goal. (Phase 2)")
    .argument("[goal...]", "Mission goal")
    .option("--template <name>", "Create the mission from a built-in Phase 15 template")
    .action(async (goalParts: string[], commandOptions: { template?: string }) => {
      const goal = goalParts.join(" ").trim();

      if (goal.length === 0 && !commandOptions.template) {
        io.writeErr("Mission goal is required.\nUsage: narthynx mission \"Prepare my launch checklist\"\n");
        process.exitCode = 1;
        return;
      }

      try {
        const mission = await missionStore.createMission(
          commandOptions.template ? createMissionInputFromTemplate(commandOptions.template, goal) : { goal }
        );
        const paths = resolveWorkspacePaths(cwd);

        io.writeOut("Mission created\n");
        io.writeOut(`id: ${mission.id}\n`);
        io.writeOut(`title: ${mission.title}\n`);
        io.writeOut(`state: ${mission.state}\n`);
        if (commandOptions.template) {
          io.writeOut(`template: ${commandOptions.template}\n`);
        }
        io.writeOut(`path: ${missionFilePath(paths.missionsDir, mission.id)}\n`);
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("templates")
    .description("List built-in mission templates. (Phase 15)")
    .action(() => {
      io.writeOut("Mission templates\n");
      for (const template of listMissionTemplates()) {
        io.writeOut(`${template.name}  risk=${template.riskProfile.level}  ${template.description}\n`);
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
    .description("Show or create a mission plan graph. Use --model for explicit Phase 12 model planning.")
    .argument("<id>", "Mission ID")
    .option("--model", "Regenerate the plan through the configured model provider")
    .action(async (id: string, commandOptions: { model?: boolean }) => {
      try {
        const graph = commandOptions.model
          ? (await modelPlanner.generatePlan(id)).graph
          : await missionStore.ensureMissionPlanGraph(id);

        io.writeOut(`Plan for ${id}${commandOptions.model ? " (model)" : ""}\n`);
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
    .command("context")
    .description("Show or update mission context diet metadata. (Phase 15)")
    .argument("<mission-id>", "Mission ID")
    .option("--note <text>", "Append a mission context note")
    .option("--file <path>", "Attach a safe local file to mission context")
    .option("--reason <text>", "Reason for attaching a file")
    .option("--pack", "Print model context pack summary (caps, truncation)")
    .option("--json", "With --pack, output JSON")
    .option("--prune-stale", "Remove stale file entries from context index (files only)")
    .action(
      async (
        missionId: string,
        commandOptions: {
          note?: string;
          file?: string;
          reason?: string;
          pack?: boolean;
          json?: boolean;
          pruneStale?: boolean;
        }
      ) => {
        try {
          const paths = resolveWorkspacePaths(cwd);
          if (commandOptions.pruneStale) {
            const n = await pruneStaleContextEntries(missionId, cwd);
            io.writeOut(`Pruned ${n} stale file context entr(y/ies).\n`);
          }

          if (commandOptions.note && commandOptions.file) {
            throw new Error("Use either --note or --file, not both.");
          }

          if (commandOptions.note) {
            await contextService.addNote(missionId, commandOptions.note);
            io.writeOut(`Context note added: ${missionId}\n`);
            io.writeOut(`${await contextService.renderContextSummary(missionId)}\n`);
            return;
          }

          if (commandOptions.file) {
            if (!commandOptions.reason) {
              throw new Error("--reason is required with --file.");
            }
            await contextService.addFile(missionId, commandOptions.file, commandOptions.reason);
            io.writeOut(`Context file attached: ${commandOptions.file}\n`);
            io.writeOut(`${await contextService.renderContextSummary(missionId)}\n`);
            return;
          }

          if (commandOptions.pack) {
            const diet = await loadContextDietConfig(paths.contextDietFile);
            if (!diet.ok) {
              throw new Error(`context-diet.yaml invalid: ${diet.message}`);
            }
            const pack = await buildModelContextPack(missionId, cwd);
            if (commandOptions.json) {
              io.writeOut(
                JSON.stringify(
                  {
                    totals: pack.totals,
                    sensitiveContextIncluded: pack.sensitiveContextIncluded,
                    entries: pack.entries,
                    diet: diet.value
                  },
                  null,
                  2
                )
              );
              io.writeOut("\n");
              return;
            }
            io.writeOut(`Model context pack for ${missionId}\n`);
            io.writeOut(
              `Budget: ${pack.totals.bytes}/${diet.value.pack_max_bytes} bytes (est. tokens ${pack.totals.estimatedTokens}`
            );
            if (diet.value.pack_max_estimated_tokens !== undefined) {
              io.writeOut(` / ${diet.value.pack_max_estimated_tokens} cap`);
            }
            io.writeOut(")\n");
            io.writeOut(`Included: ${pack.totals.includedCount}, omitted: ${pack.totals.omittedCount}\n`);
            io.writeOut(`Sensitive context in pack: ${pack.sensitiveContextIncluded}\n\n`);
            io.writeOut(pack.packText ? `${pack.packText}\n` : "(empty pack)\n");
            return;
          }

          io.writeOut(`${await contextService.renderContextSummary(missionId)}\n`);
        } catch (error) {
          writeCliError(io, error);
        }
      }
    );

  program
    .command("run")
    .description("Run or continue the Phase 13 mission executor vertical slice.")
    .argument("<mission-id>", "Mission ID")
    .action(async (missionId: string) => {
      try {
        const result = await executor.runMission(missionId);
        io.writeOut(result.output);
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
    .command("pause")
    .description("Pause a running or approval-waiting mission. (Phase 13)")
    .argument("<mission-id>", "Mission ID")
    .action(async (missionId: string) => {
      try {
        const result = await executor.pauseMission(missionId);
        io.writeOut(result.output);
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("resume")
    .description("Resume a paused or approval-waiting mission. (Phase 13)")
    .argument("<mission-id>", "Mission ID")
    .action(async (missionId: string) => {
      try {
        const result = await executor.resumeMission(missionId);
        io.writeOut(result.output);
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

  program
    .command("proof")
    .description("Generate a compact local mission proof card. (Phase 15)")
    .argument("<mission-id>", "Mission ID")
    .action(async (missionId: string) => {
      try {
        const result = await proofCardService.generateProofCard(missionId);
        io.writeOut(`${result.regenerated ? "Proof card regenerated" : "Proof card created"}\n`);
        io.writeOut(`artifact: ${result.artifact.id}\n`);
        io.writeOut(`path: ${result.path}\n`);
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("cost")
    .description("Show a mission model token and cost summary. (Phase 12)")
    .argument("<mission-id>", "Mission ID")
    .action(async (missionId: string) => {
      try {
        io.writeOut(await costService.renderMissionCost(missionId));
      } catch (error) {
        writeCliError(io, error);
      }
    });

  program
    .command("cockpit")
    .description("Start the local web Mission Cockpit (dashboard, graph, ledger, replay, approvals).")
    .option("-p, --port <port>", "HTTP port")
    .option("--host <address>", "Bind address (default 127.0.0.1)", "127.0.0.1")
    .option("--danger-listen-on-lan", "Bind 0.0.0.0 — exposes the cockpit to your LAN", false)
    .action(async (commandOptions: { port?: string; host: string; dangerListenOnLan: boolean }) => {
      try {
        let host = commandOptions.host.trim() || "127.0.0.1";
        const portParsed =
          commandOptions.port !== undefined && commandOptions.port.length > 0
            ? Number(commandOptions.port)
            : resolveCockpitPort();
        if (!Number.isInteger(portParsed) || portParsed < 1 || portParsed > 65535) {
          throw new Error("Invalid --port (use 1-65535).");
        }

        if (commandOptions.dangerListenOnLan) {
          host = "0.0.0.0";
          io.writeErr(
            "\nWARNING: Cockpit is listening on all interfaces (0.0.0.0). Anyone on your LAN may reach this server.\nSet a strong NARTHYNX_COCKPIT_TOKEN or keep default loopback binding.\n\n"
          );
        }

        await runCockpitServer({
          cwd,
          port: portParsed,
          host,
          dangerListenOnLan: commandOptions.dangerListenOnLan,
          importMetaUrl: import.meta.url,
          onListening: ({ url, token, wroteTokenFile }) => {
            io.writeOut("Narthynx Mission Cockpit\n");
            io.writeOut(`${url}\n\n`);
            io.writeOut(`Bearer token (paste in cockpit login):\n${token}\n`);
            if (wroteTokenFile) {
              io.writeOut("\nToken saved under .narthynx/cockpit/token (override with NARTHYNX_COCKPIT_TOKEN).\n");
            }
            io.writeOut("\nCtrl+C to stop.\n");
          }
        });
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
  const descriptions: Record<(typeof PLACEHOLDER_COMMANDS)[number], string> = {};

  return descriptions[commandName];
}

async function readStdinUtf8(): Promise<string> {
  if (stdin.isTTY) {
    throw new Error("stdin is a TTY — pass JSON via --file path or pipe into this command");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
