import { loadWorkspacePolicy } from "../config/load";
import { doctorWorkspace, resolveWorkspacePaths } from "../config/workspace";
import { createApprovalStore } from "../missions/approvals";
import { createCheckpointStore } from "../missions/checkpoints";
import { createReplayService } from "../missions/replay";
import { createReportService } from "../missions/reports";
import { createMissionStore } from "../missions/store";
import { createToolRegistry } from "../tools/registry";
import { createToolRunner } from "../tools/runner";
import {
  renderApprovals,
  renderDoctor,
  renderInteractiveHelp,
  renderMissionList,
  renderMissionSummary,
  renderPolicy,
  renderTools
} from "./renderer";

export interface ParsedSlashCommand {
  raw: string;
  name: string;
  args: string[];
}

export type SlashCommandResult =
  | {
      exit: true;
      output: string;
      currentMissionId?: string;
    }
  | {
      exit: false;
      output: string;
      currentMissionId?: string;
    };

export interface SlashCommandContext {
  cwd: string;
  currentMissionId?: string;
}

export function parseSlashCommand(line: string): ParsedSlashCommand {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error("Slash command must start with /.");
  }

  const tokens = tokenize(trimmed.slice(1));
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

  switch (command.name) {
    case "help":
      return stay(renderInteractiveHelp(), context.currentMissionId);
    case "exit":
    case "quit":
      return {
        exit: true,
        output: "Exiting Narthynx interactive.",
        currentMissionId: context.currentMissionId
      };
    case "doctor": {
      return stay(renderDoctor(await doctorWorkspace(context.cwd)), context.currentMissionId);
    }
    case "policy": {
      const paths = resolveWorkspacePaths(context.cwd);
      const policy = await loadWorkspacePolicy(paths.policyFile);
      if (!policy.ok) {
        return stay(`policy.yaml invalid: ${policy.message}`, context.currentMissionId);
      }

      return stay(renderPolicy(policy.value, policy.path), context.currentMissionId);
    }
    case "tools":
      return stay(renderTools(stores.toolRegistry.list()), context.currentMissionId);
    case "missions":
      return stay(renderMissionList(await stores.missionStore.listMissions()), context.currentMissionId);
    case "mission":
      return handleMissionCommand(command.args, context, stores);
    case "plan":
      return handlePlanCommand(command.args, context, stores);
    case "timeline":
      return handleTimelineCommand(command.args, context, stores);
    case "report":
      return handleReportCommand(command.args, context, stores);
    case "replay":
      return handleReplayCommand(command.args, context, stores);
    case "approve":
      return handleApproveCommand(command.args, context, stores);
    case "rewind":
      return handleRewindCommand(command.args, context, stores);
    case "tool":
      return handleToolCommand(command.args, context, stores);
    default:
      return stay(`Unknown slash command: /${command.name}\nType /help for commands.`, context.currentMissionId);
  }
}

function createInteractiveStores(cwd: string) {
  const toolRegistry = createToolRegistry();
  return {
    missionStore: createMissionStore(cwd),
    approvalStore: createApprovalStore(cwd),
    checkpointStore: createCheckpointStore(cwd),
    reportService: createReportService(cwd),
    replayService: createReplayService(cwd),
    toolRegistry,
    toolRunner: createToolRunner({ cwd, registry: toolRegistry })
  };
}

async function handleMissionCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  if (args.length === 0) {
    if (!context.currentMissionId) {
      return stay("No current mission. Run /mission <goal> or /mission <mission-id>.", context.currentMissionId);
    }

    return stay(renderMissionSummary(await stores.missionStore.readMission(context.currentMissionId)), context.currentMissionId);
  }

  const value = args.join(" ").trim();
  if (isMissionId(value)) {
    const mission = await stores.missionStore.readMission(value);
    return stay(`Switched mission\n${renderMissionSummary(mission)}`, mission.id);
  }

  const mission = await stores.missionStore.createMission({ goal: value });
  return stay(`Mission created and selected\n${renderMissionSummary(mission)}`, mission.id);
}

async function handlePlanCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  const graph = await stores.missionStore.ensureMissionPlanGraph(missionId);

  return stay(
    [`Plan for ${missionId}`, ...graph.nodes.map((node, index) => `${index + 1}. [${node.type}] ${node.title} - ${node.status}`)].join(
      "\n"
    ),
    missionId
  );
}

async function handleTimelineCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  await stores.missionStore.readMission(missionId);
  const events = await stores.missionStore.readMissionLedger(missionId, { allowMissing: true });

  if (events.length === 0) {
    return stay(`No ledger events found for mission ${missionId}.`, missionId);
  }

  return stay(
    [`Timeline for ${missionId}`, ...events.map((event, index) => `${index + 1}. ${event.timestamp}  ${event.type}  ${event.summary}`)].join(
      "\n"
    ),
    missionId
  );
}

async function handleReportCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  const result = await stores.reportService.generateMissionReport(missionId);

  return stay(
    [`${result.regenerated ? "Report regenerated" : "Report created"}`, `artifact: ${result.artifact.id}`, `path: ${result.path}`].join(
      "\n"
    ),
    missionId
  );
}

async function handleReplayCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const missionId = resolveMissionArgument(args, context.currentMissionId);
  return stay(await stores.replayService.renderMissionReplay(missionId), missionId);
}

async function handleApproveCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  const parsed = parseApprovalArgs(args);
  if (!parsed.approvalId) {
    return stay(renderApprovals(await stores.approvalStore.listPendingApprovals()), context.currentMissionId);
  }

  const decision = parsed.deny ? "denied" : "approved";
  const approval = await stores.approvalStore.decideApproval(parsed.approvalId, decision, parsed.reason);
  const output = [`Approval ${approval.status}: ${approval.id}`, `mission: ${approval.missionId}`, `tool: ${approval.toolName}`];

  if (approval.status === "approved") {
    const continuation = await stores.toolRunner.runApprovedTool(approval.id);
    if (continuation.ok) {
      output.push("Approved action executed.");
      if (continuation.checkpointId) {
        output.push(`checkpoint: ${continuation.checkpointId}`);
      }
      output.push(JSON.stringify(continuation.output, null, 2));
    } else {
      output.push(continuation.message);
    }
  } else {
    output.push("Recorded denial. The action was not executed.");
  }

  return stay(output.join("\n"), approval.missionId);
}

async function handleRewindCommand(
  args: string[],
  context: SlashCommandContext,
  stores: ReturnType<typeof createInteractiveStores>
): Promise<SlashCommandResult> {
  if (args.length === 0) {
    return stay("Checkpoint ID is required.\nUsage: /rewind <checkpoint-id> [mission-id]", context.currentMissionId);
  }

  const [checkpointId, explicitMissionId] = args;
  const missionId = explicitMissionId ?? requireCurrentMission(context.currentMissionId);
  await stores.missionStore.readMission(missionId);
  const result = await stores.checkpointStore.rewindCheckpoint(missionId, checkpointId);

  return stay(
    [
      `Checkpoint rewound: ${result.checkpoint.id}`,
      `path: ${result.checkpoint.targetPath}`,
      `file rollback: ${result.fileRollback ? "yes" : "no"}`,
      result.message
    ].join("\n"),
    missionId
  );
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
    return stay(result.message, parsed.missionId);
  }

  return stay(JSON.stringify(result.output, null, 2), parsed.missionId);
}

function resolveMissionArgument(args: string[], currentMissionId: string | undefined): string {
  if (args.length > 1) {
    throw new Error("Expected at most one mission ID argument.");
  }

  return args[0] ?? requireCurrentMission(currentMissionId);
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

function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const character of value) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new Error(`Unclosed ${quote} quote in slash command.`);
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function stay(output: string, currentMissionId: string | undefined): SlashCommandResult {
  return {
    exit: false,
    output,
    currentMissionId
  };
}

function isMissionId(value: string): boolean {
  return /^m_[a-z0-9_-]+$/.test(value);
}
