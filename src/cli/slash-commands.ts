import { readFile } from "node:fs/promises";

import { latestContextPacketLoggedMeta, loadContextPacketFromArtifact } from "../context/inspect";
import { compileContextPacket } from "../context/kernel";
import { renderWhy } from "../context/manifest";
import { loadContextDietConfig } from "../config/context-diet-config";
import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspaceActor } from "../config/identity-config";
import { doctorWorkspace, resolveWorkspacePaths } from "../config/workspace";
import { loadSubagentsConfig } from "../config/subagents-config";
import { readDaemonPid, isPidRunning } from "../daemon/process-manager";
import { readDaemonEvents } from "../daemon/event-bus";
import { readAllQueueOps, deriveQueueFromOps } from "../daemon/queue";
import { createCostService } from "../agent/cost";
import { createMissionExecutor } from "../agent/executor";
import { createModelPlanner } from "../agent/model-planner";
import { createModelRouter } from "../agent/model-router";
import { createApprovalStore } from "../missions/approvals";
import { createCheckpointStore } from "../missions/checkpoints";
import { createReplayService } from "../missions/replay";
import { createReportService } from "../missions/reports";
import { createMissionStore, missionDirectory } from "../missions/store";
import { createMissionContextService } from "../missions/context";
import { buildModelContextPack, listStaleContextEntries } from "../missions/context-diet";
import { createProofCardService } from "../missions/proof-card";
import { createMissionInputFromTemplate, listMissionTemplates } from "../missions/templates";
import { createToolRegistry } from "../tools/registry";
import { createToolRunner } from "../tools/runner";
import { runSubagentSession } from "../subagents/orchestrator";
import { buildDailyBriefingText, writeDailyBriefingArtifact } from "../companion/daily-briefing";
import { materializeCompanionMissionDraft, buildMissionDraftFromCompanionChat } from "../companion/chat";
import { acceptLatestProposedMissionSuggestion } from "../companion/mission-suggestions";
import { appendCompanionReminder, parseRemindFireAt } from "../companion/reminders";
import { detectMemoryConflicts, listOpenMemoryConflicts } from "../memory/conflicts";
import { approveMemoryProposal, listPendingProposals, rejectMemoryProposal } from "../memory/proposals";
import { listActiveMemoryItems, listMemoryRevisionLineage } from "../memory/store";
import { listApprovedMemory } from "../memory/user-memory";
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
    case "daemon":
      return handleDaemonSlash(command.args, context);
    case "events":
      return handleDaemonEventsSlash(command.args, context);
    case "queue":
      return handleDaemonQueueSlash(context);
    case "companion":
      return handleCompanionSlash(command.args, context);
    case "briefing":
      return handleBriefingSlash(command.args, context);
    case "mission-from-chat":
      return handleMissionFromChatSlash(command.args, context);
    case "remind":
      return handleRemindSlash(command.args, context);
    case "memory":
      return handleCompanionMemorySlash(command.args, context);
    case "verify":
      return handleVerifySlash(command.args, context, stores);
    case "critique":
      return handleCritiqueSlash(command.args, context, stores);
    case "subagents":
      return handleSubagentsSlash(command.args, context, stores);
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

function stripPlannerApplyFlags(tokens: string[]): {
  rest: string[];
  applyPlanner: boolean;
  plannerConfirmYes: boolean;
} {
  let applyPlanner = false;
  let plannerConfirmYes = false;
  const rest: string[] = [];
  for (const t of tokens) {
    if (t === "--apply") {
      applyPlanner = true;
      continue;
    }
    if (t === "--yes") {
      plannerConfirmYes = true;
      continue;
    }
    rest.push(t);
  }
  return { rest, applyPlanner, plannerConfirmYes };
}

function parseHypotheticalToolTokens(tokens: string[]): { hypotheticalTool?: { toolName: string; toolInput: unknown } } {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "--tool") {
      const name = tokens[i + 1];
      if (!name) {
        throw new Error("--tool requires a tool name.");
      }
      const after = tokens.slice(i + 2);
      const ij = after.indexOf("--input-json");
      if (ij !== -1) {
        const raw = after.slice(ij + 1).join(" ").trim();
        return { hypotheticalTool: { toolName: name, toolInput: parseJsonInput(raw.length > 0 ? raw : "{}") } };
      }
      return { hypotheticalTool: { toolName: name, toolInput: {} } };
    }
    if (t && !t.startsWith("--")) {
      const raw = tokens.slice(i + 1).join(" ").trim();
      return { hypotheticalTool: { toolName: t, toolInput: parseJsonInput(raw.length > 0 ? raw : "{}") } };
    }
    i += 1;
  }
  return {};
}

async function slashRunSubagent(input: {
  cwd: string;
  stores: ReturnType<typeof createInteractiveStores>;
  renderer: Renderer;
  missionId: string;
  profileId: string;
  hypotheticalTool?: { toolName: string; toolInput: unknown };
  applyPlanner?: boolean;
  plannerConfirmYes?: boolean;
}): Promise<void> {
  const router = createModelRouter({ cwd: input.cwd, approvalStore: input.stores.approvalStore });
  const result = await runSubagentSession({
    cwd: input.cwd,
    missionId: input.missionId,
    profileId: input.profileId,
    router,
    approvalStoreProvided: input.stores.approvalStore,
    hypotheticalTool: input.hypotheticalTool,
    applyPlanner: input.applyPlanner,
    plannerConfirmYes: input.plannerConfirmYes
  });

  input.renderer.rawBlock(
    JSON.stringify(
      {
        status: result.status,
        profileId: result.profileId,
        sessionId: result.sessionId,
        error: result.error,
        budgetUsed: result.budgetUsed,
        payload: result.payload,
        transcriptPreview: result.transcriptPreview
      },
      null,
      2
    )
  );

  if (result.status === "failed") {
    input.renderer.warn(result.error ?? "Subagent session failed.");
  }
}

async function handleVerifySlash(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  try {
    const missionId = resolveMissionArgument(args, context.currentMissionId);
    await slashRunSubagent({
      cwd: context.cwd,
      stores,
      renderer: context.renderer,
      missionId,
      profileId: "verifier"
    });
    return stay(missionId);
  } catch (error) {
    context.renderer.renderError(error instanceof Error ? error.message : "verify failed.");
    return stay(context.currentMissionId);
  }
}

async function handleCritiqueSlash(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  try {
    const rest = [...args];
    let missionId = context.currentMissionId;
    if (rest[0] && isMissionId(rest[0]!)) {
      missionId = rest.shift();
    }

    const mid = missionId ?? requireCurrentMission(context.currentMissionId);
    const { hypotheticalTool } = parseHypotheticalToolTokens(rest);

    await slashRunSubagent({
      cwd: context.cwd,
      stores,
      renderer: context.renderer,
      missionId: mid,
      profileId: "critic",
      hypotheticalTool
    });
    return stay(mid);
  } catch (error) {
    context.renderer.renderError(error instanceof Error ? error.message : "critique failed.");
    return stay(context.currentMissionId);
  }
}

async function handleSubagentsSlash(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const sub = (args[0] ?? "").toLowerCase();
  try {
    if (sub === "" || sub === "help") {
      context.renderer.info(
        [
          "Usage:",
          "  /subagents list",
          "  /subagents inspect <profile>",
          "  /subagents run <profile> [<mission>] [--apply] [--yes] [--tool <name> [--input-json <json>]]",
          "  /verify [<mission>]",
          "  /critique [<mission>] [--tool <name> [--input-json <json>]] | [<mission>] <tool> <json...>",
          "Or CLI: `narthynx subagents …`."
        ].join("\n")
      );
      return stay(context.currentMissionId);
    }

    const paths = resolveWorkspacePaths(context.cwd);
    const cfg = await loadSubagentsConfig(paths.subagentsFile);

    if (sub === "list") {
      if (!cfg.ok) {
        throw new Error(`subagents.yaml invalid: ${cfg.message}`);
      }
      const lines = [`enabled=${String(cfg.value.enabled)} path=${cfg.path}`, ""];
      for (const [id, profile] of Object.entries(cfg.value.profiles)) {
        lines.push(`${id}: kind=${profile.kind} maxTurns=${profile.maxTurns} tools=${profile.maxToolCallsPerSession} models=${profile.maxModelCallsPerSession}`);
      }
      context.renderer.info(lines.join("\n"));
      return stay(context.currentMissionId);
    }

    if (sub === "inspect") {
      const id = args[1]?.trim();
      if (!id) {
        throw new Error('Usage: /subagents inspect <profile>');
      }
      if (!cfg.ok) {
        throw new Error(`subagents.yaml invalid: ${cfg.message}`);
      }
      const profile = cfg.value.profiles[id];
      if (!profile) {
        throw new Error(`Unknown profile "${id}".`);
      }
      context.renderer.rawBlock(JSON.stringify(profile, null, 2));
      return stay(context.currentMissionId);
    }

    if (sub === "run") {
      const profileId = args[1]?.trim();
      if (!profileId) {
        throw new Error('Usage: /subagents run <profile> [<mission-id>] [--apply] [--yes] [--tool ...]');
      }
      let idx = 2;
      let missionId = context.currentMissionId;
      if (args[idx] && isMissionId(args[idx]!)) {
        missionId = args[idx];
        idx += 1;
      }
      const mid = missionId ?? requireCurrentMission(context.currentMissionId);
      const { rest: tail, applyPlanner, plannerConfirmYes } = stripPlannerApplyFlags(args.slice(idx));
      const { hypotheticalTool } = parseHypotheticalToolTokens(tail);

      await slashRunSubagent({
        cwd: context.cwd,
        stores,
        renderer: context.renderer,
        missionId: mid,
        profileId,
        hypotheticalTool,
        applyPlanner,
        plannerConfirmYes
      });
      return stay(mid);
    }

    throw new Error(`Unknown /subagents subcommand: ${sub}`);
  } catch (error) {
    context.renderer.renderError(error instanceof Error ? error.message : "/subagents failed.");
    return stay(context.currentMissionId);
  }
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

  if (parsed.why) {
    const meta = await latestContextPacketLoggedMeta(context.cwd, parsed.missionId);
    let block: string;
    if (meta) {
      const packet = await loadContextPacketFromArtifact(
        missionDirectory(paths.missionsDir, parsed.missionId),
        meta.packetId
      );
      block = packet ? renderWhy(packet) : renderWhy((await compileContextPacket({ cwd: context.cwd, missionId: parsed.missionId, trigger: { source: "interactive" }, persist: false })).packet);
    } else {
      const { packet } = await compileContextPacket({
        cwd: context.cwd,
        missionId: parsed.missionId,
        trigger: { source: "interactive" },
        persist: false
      });
      block = renderWhy(packet);
    }
    context.renderer.rawBlock(block.trimEnd());
    return stay(parsed.missionId);
  }

  if (parsed.diet) {
    const diet = await loadContextDietConfig(paths.contextDietFile);
    if (!diet.ok) {
      context.renderer.warn(`context-diet.yaml invalid: ${diet.message}`);
      context.renderer.rawBlock((await stores.contextService.renderContextSummary(parsed.missionId)).trimEnd());
      return stay(parsed.missionId);
    }
    const { packet } = await compileContextPacket({
      cwd: context.cwd,
      missionId: parsed.missionId,
      trigger: { source: "interactive" },
      persist: false
    });
    const lines = [
      "context-diet.yaml:",
      JSON.stringify(diet.value, null, 2),
      "",
      renderWhy(packet)
    ].join("\n");
    context.renderer.rawBlock(lines.trimEnd());
    return stay(parsed.missionId);
  }

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

  const pack = await buildModelContextPack(parsed.missionId, context.cwd, {
    trigger: { source: "interactive" },
    recordLedger: false
  });
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
): {
  missionId: string;
  note?: string;
  file?: string;
  reason?: string;
  showPack?: boolean;
  why: boolean;
  diet: boolean;
} {
  let missionId: string | undefined;
  let note: string | undefined;
  let file: string | undefined;
  let reason: string | undefined;
  let showPack = false;
  let why = false;
  let diet = false;

  let indexStart = 0;
  const first = args[0];
  if (first === "why") {
    why = true;
    indexStart = 1;
  } else if (first === "diet") {
    diet = true;
    indexStart = 1;
  }

  for (let index = indexStart; index < args.length; index += 1) {
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

  if ((why || diet) && !missionId && !currentMissionId) {
    throw new Error(`/context ${why ? "why" : "diet"} requires an active mission or an explicit mission id.`);
  }

  return {
    missionId: missionId ?? requireCurrentMission(currentMissionId),
    note,
    file,
    reason,
    showPack,
    why,
    diet
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

async function handleDaemonSlash(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const paths = resolveWorkspacePaths(context.cwd);
  const sub = (args[0] ?? "status").toLowerCase();
  if (sub !== "status") {
    context.renderer.warn('Usage: /daemon status — local snapshot from `.narthynx/daemon/`. Start daemon: `narthynx daemon start`.');
    return stay(context.currentMissionId);
  }

  const pid = await readDaemonPid(paths);
  if (pid === null) {
    context.renderer.info("Daemon: no pid file. Run `narthynx daemon start` (or `--foreground` for this terminal).");
    return stay(context.currentMissionId);
  }

  const lines = [`daemon pid: ${pid} (${isPidRunning(pid) ? "running" : "not running"})`];
  try {
    const snap = JSON.parse(await readFile(paths.daemonStatusFile, "utf8")) as Record<string, unknown>;
    lines.push("status.json:\n" + JSON.stringify(snap, null, 2));
  } catch {
    lines.push("(no status.json snapshot yet)");
  }
  context.renderer.info(lines.join("\n"));
  return stay(context.currentMissionId);
}

async function handleDaemonEventsSlash(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const paths = resolveWorkspacePaths(context.cwd);
  let since: string | undefined;
  const si = args.indexOf("--since");
  if (si !== -1 && args[si + 1]) {
    since = args[si + 1];
  }
  const events = await readDaemonEvents(paths, { since, limit: 50 });
  if (events.length === 0) {
    context.renderer.info("No daemon events in window (events.jsonl).");
    return stay(context.currentMissionId);
  }
  const text = events.map((e) => `${e.ts}  ${e.type}  ${e.summary}`).join("\n");
  context.renderer.info(`Recent daemon events (${events.length}):\n${text}`);
  return stay(context.currentMissionId);
}

async function handleDaemonQueueSlash(context: SlashCommandContext): Promise<SlashCommandResult> {
  const paths = resolveWorkspacePaths(context.cwd);
  const ops = await readAllQueueOps(paths);
  const snap = deriveQueueFromOps(ops);
  const lines = [
    `pending: ${snap.pending.length}`,
    snap.processing ? `processing: ${snap.processing.id} (${snap.processing.job.kind})` : "processing: (none)"
  ];
  for (const p of snap.pending.slice(0, 12)) {
    lines.push(`  - ${p.id}  ${p.job.kind}`);
  }
  if (snap.pending.length > 12) {
    lines.push(`  … ${snap.pending.length - 12} more`);
  }
  context.renderer.info(lines.join("\n"));
  return stay(context.currentMissionId);
}

function handleCompanionSlash(args: string[], context: SlashCommandContext): SlashCommandResult {
  const sub = args[0]?.toLowerCase();
  if (sub === "off" || sub === "mission") {
    context.session.companionSurfaceActive = false;
    context.renderer.info("Companion conversational surface OFF — natural language routes to mission planner again.");
    return stay(context.currentMissionId);
  }

  if (sub === "session" && args[1]) {
    context.session.companionSessionId = args[1]!;
    context.session.companionSurfaceActive = true;
    context.renderer.info(`Companion session id "${context.session.companionSessionId}"`);
    return stay(context.currentMissionId);
  }

  context.session.companionSurfaceActive = true;
  context.renderer.info(
    `Companion surface ON — session "${context.session.companionSessionId}". Type normally; slash /companion mission to leave. Execution stays missions-only (/run).`
  );
  return stay(context.currentMissionId);
}

async function handleBriefingSlash(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const paths = resolveWorkspacePaths(context.cwd);
  const write = args.includes("--write");
  if (write) {
    const fp = await writeDailyBriefingArtifact({ cwd: context.cwd, paths });
    context.renderer.info(`Briefing artifact written:\n${fp}`);
  } else {
    context.renderer.info(await buildDailyBriefingText({ cwd: context.cwd, paths }));
  }
  return stay(context.currentMissionId);
}

async function handleMissionFromChatSlash(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const sub = args[0]?.toLowerCase();
  const paths = resolveWorkspacePaths(context.cwd);
  const sid = context.session.companionSessionId;

  if (!sub || sub === "draft") {
    const draft = await buildMissionDraftFromCompanionChat(context.cwd, sid);
    context.renderer.panel("Mission draft", draft);
    return stay(context.currentMissionId);
  }

  if (sub === "accept") {
    const result = await acceptLatestProposedMissionSuggestion(paths, context.cwd);
    if ("error" in result) {
      context.renderer.warn(result.error);
    } else {
      context.renderer.info(`Mission ${result.missionId} created from companion suggestion ${result.suggestionId}.`);
      return stay(result.missionId);
    }
    return stay(context.currentMissionId);
  }

  if (sub === "materialize") {
    const draft = await buildMissionDraftFromCompanionChat(context.cwd, sid);
    const m = await materializeCompanionMissionDraft(context.cwd, draft);
    context.renderer.info(`Mission ${m.missionId} created from transcript draft.`);
    return stay(m.missionId);
  }

  context.renderer.warn("Usage: /mission-from-chat [draft | accept | materialize]");
  return stay(context.currentMissionId);
}

async function handleRemindSlash(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  if (args.length < 2) {
    context.renderer.warn("Usage: /remind +<minutes>|ISO8601 <message text...>");
    return stay(context.currentMissionId);
  }

  const when = args[0]!;
  const message = args.slice(1).join(" ").trim();
  if (!message) {
    context.renderer.warn("Reminder message is required after the schedule token.");
    return stay(context.currentMissionId);
  }

  const paths = resolveWorkspacePaths(context.cwd);
  const sched = parseRemindFireAt(when, Date.now());
  if (!sched.ok) {
    context.renderer.warn(sched.reason);
    return stay(context.currentMissionId);
  }

  const row = await appendCompanionReminder(paths, {
    fireAt: sched.fireAtIso,
    message,
    sessionId: context.session.companionSessionId,
    status: "pending"
  });

  const daemonPaths = paths;
  const pid = await readDaemonPid(daemonPaths);
  const running = pid !== null && isPidRunning(pid);
  context.renderer.info(
    `Reminder ${row.id} scheduled for ${row.fireAt}.\n` +
      (running
        ? "Daemon appears to be running — delivery will be attempted on the next tick."
        : "Daemon is not running — reminder is saved locally, but delivery requires the Narthynx daemon (see docs/daemon.md).")
  );
  return stay(context.currentMissionId);
}

async function handleCompanionMemorySlash(args: string[], context: SlashCommandContext): Promise<SlashCommandResult> {
  const paths = resolveWorkspacePaths(context.cwd);
  const policy = await loadWorkspacePolicy(paths.policyFile);
  if (!policy.ok) {
    context.renderer.renderError(`policy.yaml invalid: ${policy.message}`);
    return stay(context.currentMissionId);
  }

  const sub = args[0]?.toLowerCase();

  if (sub === "approve") {
    const id = args[1];
    if (!id) {
      context.renderer.warn("Usage: /memory approve <proposalId>");
      return stay(context.currentMissionId);
    }
    const ok = await approveMemoryProposal(paths, id, policy.value);
    context.renderer.info(ok ? `Approved memory proposal ${id}.` : `No pending proposal ${id}.`);
    return stay(context.currentMissionId);
  }

  if (sub === "reject") {
    const id = args[1];
    if (!id) {
      context.renderer.warn("Usage: /memory reject <proposalId>");
      return stay(context.currentMissionId);
    }
    const ok = await rejectMemoryProposal(paths, id);
    context.renderer.info(ok ? `Rejected proposal ${id}.` : `No pending proposal ${id}.`);
    return stay(context.currentMissionId);
  }

  if (sub === "conflicts") {
    const open = await listOpenMemoryConflicts(paths);
    const items = await listActiveMemoryItems(paths);
    const pairs = detectMemoryConflicts(items);
    const lines = [
      "Memory conflicts",
      "",
      `Open recorded: ${open.length}`,
      ...open.map((c) => `  ${c.id}: ${c.item_ids.join(" vs ")}`),
      "",
      `Heuristic overlaps (not auto-recorded): ${pairs.length}`,
      ...pairs.slice(0, 12).map(
        (p) => `  ${p.similarity.toFixed(2)}  ${p.a.id} <> ${p.b.id}`
      )
    ];
    if (pairs.length > 12) {
      lines.push(`  …and ${pairs.length - 12} more`);
    }
    context.renderer.info(lines.join("\n"));
    return stay(context.currentMissionId);
  }

  if (sub === "diff") {
    const a = args[1];
    const b = args[2];
    if (!a || !b) {
      context.renderer.warn("Usage: /memory diff <itemIdA> <itemIdB>");
      return stay(context.currentMissionId);
    }
    const left = await listMemoryRevisionLineage(paths, a);
    const right = await listMemoryRevisionLineage(paths, b);
    if (left.length === 0 || right.length === 0) {
      context.renderer.warn("One or both ids have no stored revisions.");
      return stay(context.currentMissionId);
    }
    const la = left[left.length - 1]!;
    const rb = right[right.length - 1]!;
    context.renderer.panel(
      "Memory diff (latest revisions)",
      `--- ${a} (${la.updated_at})\n${la.text}\n\n--- ${b} (${rb.updated_at})\n${rb.text}`
    );
    return stay(context.currentMissionId);
  }

  if (sub && !["approve", "reject", "conflicts", "diff", "list"].includes(sub)) {
    context.renderer.warn(
      `Unknown /memory subcommand "${sub}". Try /memory, /memory list, /memory approve <id>, /memory conflicts, /memory diff <a> <b>.`
    );
    return stay(context.currentMissionId);
  }

  const pendingRows = await listPendingProposals(paths);
  const approved = await listApprovedMemory(paths);
  const lines = [
    "Governed memory (F18)",
    "",
    "Pending proposals:",
    ...pendingRows.map(
      (p) => `  ${p.id}  ${p.updated_at}  ${p.text.slice(0, 120)}${p.text.length > 120 ? "…" : ""}`
    ),
    "",
    "Approved snippets (user + relationship scopes):",
    ...approved.slice(0, 20).map((a) => `  ${a.id}  ${a.ts}  ${a.text.slice(0, 120)}${a.text.length > 120 ? "…" : ""}`)
  ];
  context.renderer.info(lines.join("\n"));
  return stay(context.currentMissionId);
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
