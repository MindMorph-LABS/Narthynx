import type { DoctorResult } from "../config/workspace";
import type { ApprovalRequest } from "../missions/approvals";
import type { PlanGraph } from "../missions/graph";
import type { LedgerEvent } from "../missions/ledger";
import type { Mission } from "../missions/schema";
import type { MissionTemplate } from "../missions/templates";
import type { WorkspacePolicy } from "../config/load";
import type { ToolAction } from "../tools/types";
import type { InteractiveSessionState, CockpitMode } from "./session";

type TextTableRow = string[];

export interface InteractiveIo {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
}

export interface IntroParams {
  workspace: string;
  policyLabel: string;
  cockpitMode: CockpitMode;
  modelLabel: string;
  activeMissionId: string;
}

export interface StatusParams {
  cockpitMode: CockpitMode;
  mission?: Mission;
  policyMode?: WorkspacePolicy["mode"];
  modelLabel: string;
}

export interface Renderer {
  intro(params: IntroParams): void;
  status(params: StatusParams): void;
  formatPrompt(session: InteractiveSessionState, mission?: Mission): string;
  info(message: string): void;
  warn(message: string): void;
  renderError(message: string): void;
  table(rows: TextTableRow[]): void;
  panel(title: string, body: string): void;
  missionList(missions: Mission[]): void;
  plan(missionId: string, lines: string[], modelSuffix?: string): void;
  graph(graph: PlanGraph): void;
  timeline(missionId: string, events: LedgerEvent[]): void;
  approvalPrompt(approval: ApprovalRequest, missionTitle?: string): void;
  help(): void;
  doctor(result: DoctorResult): void;
  missionSummary(mission: Mission): void;
  templates(templates: MissionTemplate[]): void;
  policy(policy: WorkspacePolicy, path: string): void;
  tools(tools: ToolAction<unknown, unknown>[]): void;
  approvals(list: ApprovalRequest[]): void;
  rawBlock(text: string): void;
  clear(): void;
}

export function resolveModelLabel(): string {
  const provider = process.env.NARTHYNX_MODEL_PROVIDER?.trim();
  return provider && provider.length > 0 ? provider : "auto";
}
