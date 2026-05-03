import { loadContextDietConfig } from "../config/context-diet-config";
import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspaceActor } from "../config/identity-config";
import { doctorWorkspace, resolveWorkspacePaths } from "../config/workspace";
import { createCostService } from "../agent/cost";
import { createMissionExecutor } from "../agent/executor";
import { createModelPlanner } from "../agent/model-planner";
import { createApprovalStore } from "../missions/approvals";
import { createCheckpointStore } from "../missions/checkpoints";
import { createReplayService } from "../missions/replay";
import { createReportService } from "../missions/reports";
import { createMissionStore } from "../missions/store";
import { createMissionContextService } from "../missions/context";
import { buildModelContextPack, listStaleContextEntries } from "../missions/context-diet";
import { createProofCardService } from "../missions/proof-card";
import { createMissionInputFromTemplate, listMissionTemplates } from "../missions/templates";
import { createToolRegistry } from "../tools/registry";
import { createToolRunner } from "../tools/runner";
import type { Renderer } from "./renderer";
import { isCockpitMode, type InteractiveSessionState } from "./session";
import { tokenizeSlashRest } from "./tokenize";

export { parseShellShortcut } from "./shortcuts";

export interface ParsedSlashCommand {
  raw: string;
  name: string;
  args: string[];
}

export interface PendingApprovalInteractive {
  approvalId: string;
  missionId: string;
}

export type SlashCommandResult =
  | {
      exit: true;
      currentMissionId?: string;
    }
  | {
      exit: false;
      currentMissionId?: string;
      pendingApproval?: PendingApprovalInteractive;
    };

export interface SlashCommandContext {
  cwd: string;
  currentMissionId?: string;
  session: InteractiveSessionState;
  renderer: Renderer;
}

export function parseSlashCommand(line: string): ParsedSlashCommand {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error("Slash command must start with /.");
  }

  const tokens = tokenizeSlashRest(trimmed.slice(1));
  const [name, ...args] = tokens;
  if (!name) {
    throw new Error("Slash command is required. Type /help for commands.");
  }

  return {
    raw: trimmed,
    name: name.toLowerCase(),
    args
  };
}

export async function dispatchSlashCommand(
  command: ParsedSlashCommand,
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  const stores = createInteractiveStores(context.cwd);
  const { renderer } = context;

  switch (command.name) {
    case "help":
      renderer.help();
      return stay(context.currentMissionId);
    case "exit":
    case "quit":
      renderer.info("Exiting Narthynx interactive.");
      return exit(context.currentMissionId);
    case "clear":
      renderer.clear();
      return stay(context.currentMissionId);
    case "doctor": {
      renderer.doctor(await doctorWorkspace(context.cwd));
      return stay(context.currentMissionId);
    }
    case "policy": {
      const paths = resolveWorkspacePaths(context.cwd);
      const policy = await loadWorkspacePolicy(paths.policyFile);
      if (!policy.ok) {
        renderer.renderError(`policy.yaml invalid: ${policy.message}`);
        return stay(context.currentMissionId);
      }
      renderer.policy(policy.value, policy.path);
      return stay(context.currentMissionId);
    }
    case "tools":
      renderer.tools(stores.toolRegistry.list());
      return stay(context.currentMissionId);
    case "missions":
      renderer.missionList(await stores.missionStore.listMissions());
      return stay(context.currentMissionId);
    case "templates":
      renderer.templates(listMissionTemplates());
      return stay(context.currentMissionId);
    case "mission":
      return handleMissionCommand(command.args, context, stores);
    case "plan":
      return handlePlanCommand(command.args, context, stores);
    case "graph":
      return handleGraphCommand(command.args, context, stores);
    case "run":
      return handleRunCommand(command.args, context, stores);
    case "timeline":
      return handleTimelineCommand(command.args, context, stores);
    case "report":
      return handleReportCommand(command.args, context, stores);
    case "proof":
      return handleProofCommand(command.args, context, stores);
    case "replay":
      return handleReplayCommand(command.args, context, stores);
    case "context":
      return handleContextCommand(command.args, context, stores);
    case "cost":
      return handleCostCommand(command.args, context, stores);
    case "approve":
      return handleApproveCommand(command.args, context, stores);
    case "rewind":
      return handleRewindCommand(command.args, context, stores);
    case "pause":
      return handlePauseCommand(command.args, context, stores);
    case "resume":
      return handleResumeCommand(command.args, context, stores);
    case "tool":
      return handleToolCommand(command.args, context, stores);
    case "mode":
      return handleModeCommand(command.args, context);
    default:
      renderer.warn(
        `Unknown slash command: /${command.name}\n` +
          "Try /help for the full list. Common: /mission, /run, /plan, /doctor, /exit."
      );
      return stay(context.currentMissionId);
  }
}

function createInteractiveStores(cwd: string) {
  const toolRegistry = createToolRegistry();
  const approvalStore = createApprovalStore(cwd);
  return {
    missionStore: createMissionStore(cwd),
    approvalStore,
    checkpointStore: createCheckpointStore(cwd),
    reportService: createReportService(cwd),
    replayService: createReplayService(cwd),
    contextService: createMissionContextService(cwd),
    proofCardService: createProofCardService(cwd),
    costService: createCostService(cwd),
    modelPlanner: createModelPlanner(cwd, { approvalStore }),
    executor: createMissionExecutor(cwd),
    toolRegistry,
    toolRunner: createToolRunner({ cwd, registry: toolRegistry })
  };
}

async function handleMissionCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const { renderer } = context;
  if (args.length === 0) {
    if (!context.currentMissionId) {
      renderer.warn("No current mission. Run /mission <goal> or /mission <mission-id>.");
      return stay(context.currentMissionId);
    }

    renderer.missionSummary(await stores.missionStore.readMission(context.currentMissionId));
    return stay(context.currentMissionId);
  }

  const parsed = parseMissionArgs(args);
  if (parsed.templateName) {
    const mission = await stores.missionStore.createMission(createMissionInputFromTemplate(parsed.templateName, parsed.goal));
    renderer.info(`Mission created and selected\ntemplate: ${parsed.templateName}`);
    renderer.missionSummary(mission);
    return stay(mission.id);
  }

  const value = parsed.goal;
  if (isMissionId(value)) {
    const mission = await stores.missionStore.readMission(value);
    renderer.info("Switched mission");
    renderer.missionSummary(mission);
    return stay(mission.id);
  }

  const mission = await stores.missionStore.createMission({ goal: value });
  renderer.info("Mission created and selected");
  renderer.missionSummary(mission);
  return stay(mission.id);
}

async function handlePlanCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const parsed = parsePlanArgs(args, context.currentMissionId);
  const graph = parsed.useModel
    ? (await stores.modelPlanner.generatePlan(parsed.missionId)).graph
    : await stores.missionStore.ensureMissionPlanGraph(parsed.missionId);

  const lines = graph.nodes.map((node, index) => `${index + 1}. [${node.type}] ${node.title} - ${node.status}`);
  rendererPlan(context, parsed.missionId, lines, parsed.useModel ? " (model)" : "");
  return stay(parsed.missionId);
}

function rendererPlan(context: SlashCommandContext, missionId: string, lines: string[], modelSuffix: string): void {
  context.renderer.plan(missionId, lines, modelSuffix);
}

async function handleGraphCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  const graph = await stores.missionStore.readMissionPlanGraph(missionId);
  context.renderer.graph(graph);
  return stay(missionId);
}

async function handleTimelineCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  await stores.missionStore.readMission(missionId);
  const events = await stores.missionStore.readMissionLedger(missionId, { allowMissing: true });
  context.renderer.timeline(missionId, events);
  return stay(missionId);
}

async function handleRunCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  const result = await stores.executor.runMission(missionId);
  return finishExecutorOutput(result, missionId, context, stores);
}

async function handleResumeCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  const result = await stores.executor.resumeMission(missionId);
  return finishExecutorOutput(result, missionId, context, stores);
}

async function finishExecutorOutput(
  result: Awaited<ReturnType<ReturnType<typeof createMissionExecutor>["runMission"]>>,
  missionId: string,
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  context.renderer.rawBlock(result.output.trimEnd());
  if (result.status === "paused_for_approval" && result.approvalId) {
    const approval = await stores.approvalStore.getApproval(result.approvalId);
    const mission = await stores.missionStore.readMission(missionId);
    context.renderer.approvalPrompt(approval, mission.title);
    return {
      exit: false,
      currentMissionId: missionId,
      pendingApproval: { approvalId: result.approvalId, missionId }
    };
  }
  return stay(missionId);
}

async function handleReportCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  const result = await stores.reportService.generateMissionReport(missionId);
  context.renderer.info(
    [`${result.regenerated ? "Report regenerated" : "Report created"}`, `artifact: ${result.artifact.id}`, `path: ${result.path}`].join("\n")
  );
  return stay(missionId);
}

async function handleProofCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  const result = await stores.proofCardService.generateProofCard(missionId);
  context.renderer.info(
    [`${result.regenerated ? "Proof card regenerated" : "Proof card created"}`, `artifact: ${result.artifact.id}`, `path: ${result.path}`].join("\n")
  );
  return stay(missionId);
}

async function handleReplayCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  context.renderer.rawBlock((await stores.replayService.renderMissionReplay(missionId)).trimEnd());
  return stay(missionId);
}

async function handleCostCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  context.renderer.rawBlock((await stores.costService.renderMissionCost(missionId)).trimEnd());
  return stay(missionId);
}

async function handleContextCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const parsed = parseContextArgs(args, context.currentMissionId);
  const paths = resolveWorkspacePaths(context.cwd);

  if (parsed.note) {
    await stores.contextService.addNote(parsed.missionId, parsed.note);
    context.renderer.info(`Context note added: ${parsed.missionId}`);
    context.renderer.rawBlock((await stores.contextService.renderContextSummary(parsed.missionId)).trimEnd());
    return stay(parsed.missionId);
  }

  if (parsed.file) {
    await stores.contextService.addFile(parsed.missionId, parsed.file, parsed.reason ?? "");
    context.renderer.info(`Context file attached: ${parsed.file}`);
    context.renderer.rawBlock((await stores.contextService.renderContextSummary(parsed.missionId)).trimEnd());
    return stay(parsed.missionId);
  }

  const diet = await loadContextDietConfig(paths.contextDietFile);
  if (!diet.ok) {
    context.renderer.warn(`context-diet.yaml invalid: ${diet.message}`);
    context.renderer.rawBlock((await stores.contextService.renderContextSummary(parsed.missionId)).trimEnd());
    return stay(parsed.missionId);
  }

  const pack = await buildModelContextPack(parsed.missionId, context.cwd, { recordLedger: false });
  const stale = await listStaleContextEntries(parsed.missionId, context.cwd);
  const staleLines = stale.filter((s) => s.stale);

  if (parsed.showPack) {
    context.renderer.rawBlock(
      [
        `Pack budget: ${pack.totals.bytes}/${diet.value.pack_max_bytes} bytes (est. tokens ${pack.totals.estimatedTokens})`,
        `Sensitive in pack: ${pack.sensitiveContextIncluded}`,
        "",
        pack.packText || "(empty pack)"
      ].join("\n")
    );
    return stay(parsed.missionId);
  }

  const lines = [
    (await stores.contextService.renderContextSummary(parsed.missionId)).trimEnd(),
    "",
    `[Pack] ${pack.totals.bytes}/${diet.value.pack_max_bytes} bytes · est. tokens ${pack.totals.estimatedTokens}${
      diet.value.pack_max_estimated_tokens !== undefined ? ` / cap ${diet.value.pack_max_estimated_tokens}` : ""
    }`,
    staleLines.length > 0
      ? `[Stale] ${staleLines.map((s) => `${s.type}:${s.source}`).join(", ")}`
      : "[Stale] none"
  ].join("\n");
  context.renderer.rawBlock(lines);
  return stay(parsed.missionId);
}

async function handleApproveCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const parsed = parseApprovalArgs(args);
  if (!parsed.approvalId) {
    context.renderer.approvals(await stores.approvalStore.listPendingApprovals());
    return stay(context.currentMissionId);
  }

  const decision = parsed.deny ? "denied" : "approved";
  const paths = resolveWorkspacePaths(context.cwd);
  const actor = await resolveWorkspaceActor(paths.identityFile);
  const approval = await stores.approvalStore.decideApproval(parsed.approvalId, decision, parsed.reason, { actor });
  context.renderer.info(`Approval ${approval.status}: ${approval.id}`);
  context.renderer.info(`mission: ${approval.missionId}`);
  context.renderer.info(`tool: ${approval.toolName}`);

  if (approval.status === "approved") {
    const continuation = await stores.toolRunner.runApprovedTool(approval.id);
    if (continuation.ok) {
      context.renderer.info("Approved action executed.");
      if (continuation.checkpointId) {
        context.renderer.info(`checkpoint: ${continuation.checkpointId}`);
      }
      context.renderer.rawBlock(JSON.stringify(continuation.output, null, 2));
      return stay(approval.missionId);
    }
    context.renderer.warn(continuation.message);
    return stay(approval.missionId);
  }

  context.renderer.info("Recorded denial. The action was not executed.");
  return stay(approval.missionId);
}

async function handleRewindCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  if (args.length === 0) {
    context.renderer.warn("Checkpoint ID is required.\nUsage: /rewind <checkpoint-id> [mission-id]");
    return stay(context.currentMissionId);
  }

  const [checkpointId, explicitMissionId] = args;
  const missionId = explicitMissionId ?? requireCurrentMission(context.currentMissionId);
  await stores.missionStore.readMission(missionId);
  const result = await stores.checkpointStore.rewindCheckpoint(missionId, checkpointId);
  context.renderer.info(
    [`Checkpoint rewound: ${result.checkpoint.id}`, `path: ${result.checkpoint.targetPath}`, `file rollback: ${result.fileRollback ? "yes" : "no"}`, result.message].join(
      "\n"
    )
  );
  return stay(missionId);
}

async function handlePauseCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  const result = await stores.executor.pauseMission(missionId);
  context.renderer.rawBlock(result.output.trimEnd());
  return stay(missionId);
}

async function handleToolCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const parsed = parseToolArgs(args, context.currentMissionId);
  const result = await stores.toolRunner.runTool({
    missionId: parsed.missionId,
    toolName: parsed.toolName,
    input: parsed.input
  });

  if (!result.ok) {
    context.renderer.warn(result.message);
    if ("approvalId" in result && result.approvalId) {
      const approval = await stores.approvalStore.getApproval(result.approvalId);
      const mission = await stores.missionStore.readMission(parsed.missionId);
      context.renderer.approvalPrompt(approval, mission.title);
      return {
        exit: false,
        currentMissionId: parsed.missionId,
        pendingApproval: { approvalId: result.approvalId, missionId: parsed.missionId }
      };
    }
    return stay(parsed.missionId);
  }

  context.renderer.rawBlock(JSON.stringify(result.output, null, 2));
  return stay(parsed.missionId);
}

function resolveMissionArgument(args: string[], currentMissionId: string | undefined): string {
  if (args.length > 1) {
    throw new Error("Expected at most one mission ID argument.");
  }

  return args[0] ?? requireCurrentMission(currentMissionId);
}

function parseMissionArgs(args: string[]): { templateName?: string; goal: string } {
  const remaining: string[] = [];
  let templateName: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--template") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("--template requires a template name.");
      }
      templateName = next;
      index += 1;
    } else {
      remaining.push(value);
    }
  }

  const goal = remaining.join(" ").trim();
  if (!templateName && goal.length === 0) {
    throw new Error("Mission goal is required.");
  }

  return {
    templateName,
    goal
  };
}

function parseContextArgs(
  args: string[],
  currentMissionId: string | undefined
): { missionId: string; note?: string; file?: string; reason?: string; showPack?: boolean } {
  let missionId: string | undefined;
  let note: string | undefined;
  let file: string | undefined;
  let reason: string | undefined;
  let showPack = false;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--note") {
      const collected = collectFlagText(args, index + 1, ["--file", "--reason", "--pack"]);
      note = collected.text;
      index = collected.nextIndex - 1;
    } else if (value === "--file") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("--file requires a path.");
      }
      file = next;
      index += 1;
    } else if (value === "--reason") {
      const collected = collectFlagText(args, index + 1, ["--note", "--file", "--pack"]);
      reason = collected.text;
      index = collected.nextIndex - 1;
    } else if (value === "--pack") {
      showPack = true;
    } else if (!missionId) {
      missionId = value;
    } else {
      throw new Error(`Unexpected context argument: ${value}`);
    }
  }

  if (note && file) {
    throw new Error("Use either --note or --file, not both.");
  }

  if (file && !reason) {
    throw new Error("--reason is required with --file.");
  }

  return {
    missionId: missionId ?? requireCurrentMission(currentMissionId),
    note,
    file,
    reason,
    showPack
  };
}

function collectFlagText(args: string[], startIndex: number, stopFlags: string[]): { text: string; nextIndex: number } {
  const values: string[] = [];
  let index = startIndex;
  for (; index < args.length; index += 1) {
    if (stopFlags.includes(args[index])) {
      break;
    }
    values.push(args[index]);
  }

  const text = values.join(" ").trim();
  if (!text) {
    throw new Error("Flag requires text.");
  }

  return { text, nextIndex: index };
}

function parsePlanArgs(args: string[], currentMissionId: string | undefined): { missionId: string; useModel: boolean } {
  const remaining: string[] = [];
  let useModel = false;

  for (const arg of args) {
    if (arg === "--model") {
      useModel = true;
    } else {
      remaining.push(arg);
    }
  }

  return {
    missionId: resolveMissionArgument(remaining, currentMissionId),
    useModel
  };
}

function requireCurrentMission(currentMissionId: string | undefined): string {
  if (!currentMissionId) {
    throw new Error("No current mission. Run /mission <goal> or /mission <mission-id>.");
  }

  return currentMissionId;
}

function parseApprovalArgs(args: string[]): { approvalId?: string; deny: boolean; reason?: string } {
  let approvalId: string | undefined;
  let deny = false;
  let reason: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--deny") {
      deny = true;
    } else if (value === "--reason") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("--reason requires text.");
      }
      reason = next;
      index += 1;
    } else if (!approvalId) {
      approvalId = value;
    } else {
      throw new Error(`Unexpected approval argument: ${value}`);
    }
  }

  return { approvalId, deny, reason };
}

function parseToolArgs(
  args: string[],
  currentMissionId: string | undefined
): { missionId: string; toolName: string; input: unknown } {
  const inputFlagIndex = args.indexOf("--input");
  if (inputFlagIndex === -1 || inputFlagIndex === args.length - 1) {
    throw new Error('Usage: /tool [mission-id] <tool-name> --input \'{"path":"."}\'');
  }

  const beforeInput = args.slice(0, inputFlagIndex);
  const inputJson = args.slice(inputFlagIndex + 1).join(" ");
  const input = parseJsonInput(inputJson);

  if (beforeInput.length === 1) {
    return {
      missionId: requireCurrentMission(currentMissionId),
      toolName: beforeInput[0],
      input
    };
  }

  if (beforeInput.length === 2) {
    return {
      missionId: beforeInput[0],
      toolName: beforeInput[1],
      input
    };
  }

  throw new Error('Usage: /tool [mission-id] <tool-name> --input \'{"path":"."}\'');
}

function parseJsonInput(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    throw new Error(`Invalid --input JSON: ${message}`);
  }
}

function handleModeCommand(args: string[], context: SlashCommandContext): SlashCommandResult {
  const { renderer, session } = context;
  if (args.length === 0) {
    renderer.info(`Cockpit mode: ${session.cockpitMode} (plan | ask). Usage: /mode plan | /mode ask`);
    return stay(context.currentMissionId);
  }

  const value = args[0].toLowerCase();
  if (isCockpitMode(value)) {
    session.cockpitMode = value;
    renderer.info(`Cockpit mode set to: ${value}`);
    return stay(context.currentMissionId);
  }

  renderer.warn(`Unknown mode "${args[0]}". Use /mode plan or /mode ask.`);
  return stay(context.currentMissionId);
}

function stay(currentMissionId: string | undefined): SlashCommandResult {
  return {
    exit: false,
    currentMissionId
  };
}

function exit(currentMissionId: string | undefined): SlashCommandResult {
  return {
    exit: true,
    currentMissionId
  };
}

function isMissionId(value: string): boolean {
  return /^m_[a-z0-9_-]+$/.test(value);
}
