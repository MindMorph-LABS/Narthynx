import type { DoctorResult } from "../config/workspace";
import type { ApprovalRequest } from "../missions/approvals";
import type { Mission } from "../missions/schema";
import type { WorkspacePolicy } from "../config/load";
import type { ToolAction } from "../tools/types";

export interface InteractiveStatusInput {
  policyMode?: WorkspacePolicy["mode"];
  mission?: Mission;
  modelProvider?: string;
}

export function renderStatusLine(input: InteractiveStatusInput): string {
  const mode = titleCase(input.policyMode ?? "ask");
  const missionId = input.mission?.id ?? "none";
  const state = input.mission?.state ?? "none";
  const risk = input.mission?.riskProfile.level ?? "none";
  const model = input.modelProvider ?? "stub";

  return `Narthynx  mode: ${mode}  mission: ${missionId}  state: ${state}  risk: ${risk}  model: ${model}`;
}

export function renderPrompt(missionId?: string): string {
  return missionId ? `nx:${missionId}> ` : "nx> ";
}

export function renderInteractiveWelcome(): string {
  return [
    "Narthynx interactive",
    "Local-first Mission Agent OS. Persistent missions. Approval-gated actions. Replayable execution.",
    "Type /help for commands or /exit to leave."
  ].join("\n");
}

export function renderInteractiveHelp(): string {
  return [
    "Narthynx slash commands",
    "/mission <goal|mission-id>    Create a mission or switch to an existing mission",
    "/mission                      Show the current mission",
    "/missions                     List missions",
    "/plan [mission-id]            Show the mission plan",
    "/timeline [mission-id]        Show the raw mission ledger",
    "/tool [mission-id] <name> --input <json>",
    "/approve [approval-id] [--deny] [--reason <text>]",
    "/rewind <checkpoint-id> [mission-id]",
    "/report [mission-id]          Generate a deterministic report artifact",
    "/replay [mission-id]          Replay the mission story",
    "/cost [mission-id]            Show model token and cost summary",
    "/policy                       Inspect policy.yaml",
    "/tools                        List typed tools",
    "/doctor                       Run workspace health checks",
    "/help                         Show this help",
    "/exit                         Exit interactive mode",
    "",
    "Shortcuts",
    "! <command>                   Request approval for shell.run",
    "@ <path>                      Reserved for future context attachment",
    "# <note>                      Reserved for future mission memory"
  ].join("\n");
}

export function renderDoctor(result: DoctorResult): string {
  const lines = ["Narthynx doctor"];
  for (const check of result.checks) {
    lines.push(`${check.ok ? "ok" : "fail"}  ${check.name}: ${check.message}`);
  }
  lines.push(result.ok ? "Workspace is healthy." : "Workspace is not healthy. Run: narthynx init");
  return lines.join("\n");
}

export function renderMissionSummary(mission: Mission): string {
  return [
    `Mission ${mission.id}`,
    `title: ${mission.title}`,
    `goal: ${mission.goal}`,
    `state: ${mission.state}`,
    `risk: ${mission.riskProfile.level} (${mission.riskProfile.reasons.join("; ")})`
  ].join("\n");
}

export function renderMissionList(missions: Mission[]): string {
  if (missions.length === 0) {
    return "No missions found.";
  }

  return ["Missions", ...missions.map((mission) => `${mission.id}  ${mission.state}  ${mission.createdAt}  ${mission.title}`)].join(
    "\n"
  );
}

export function renderPolicy(policy: WorkspacePolicy, path: string): string {
  return [
    "Policy",
    `path: ${path}`,
    `mode: ${policy.mode}`,
    `allow_network: ${policy.allow_network}`,
    `shell: ${policy.shell}`,
    `filesystem.read: ${policy.filesystem.read.join(", ")}`,
    `filesystem.write: ${policy.filesystem.write.join(", ")}`,
    `filesystem.deny: ${policy.filesystem.deny.join(", ")}`,
    `external_communication: ${policy.external_communication}`,
    `credentials: ${policy.credentials}`,
    `cloud_model_sensitive_context: ${policy.cloud_model_sensitive_context}`,
    "Policy editing is not implemented yet."
  ].join("\n");
}

export function renderTools(tools: ToolAction<unknown, unknown>[]): string {
  return [
    "Tools",
    ...tools.map(
      (tool) =>
        `${tool.name}  risk=${tool.riskLevel}  sideEffect=${tool.sideEffect}  approval=${tool.requiresApproval ? "yes" : "no"}`
    )
  ].join("\n");
}

export function renderApprovals(approvals: ApprovalRequest[]): string {
  if (approvals.length === 0) {
    return "No pending approvals.";
  }

  return [
    "Pending approvals",
    ...approvals.flatMap((approval) => [
      `${approval.id}  mission=${approval.missionId}  tool=${approval.toolName}  risk=${approval.riskLevel}  status=${approval.status}`,
      `  ${approval.prompt.split(/\r?\n/)[0]}`
    ])
  ].join("\n");
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
