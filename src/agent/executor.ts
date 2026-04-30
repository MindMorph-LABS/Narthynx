import { resolveWorkspacePaths } from "../config/workspace";
import type { ApprovalRequest } from "../missions/approvals";
import { createApprovalStore } from "../missions/approvals";
import type { MissionNode, MissionNodeStatus } from "../missions/graph";
import { appendLedgerEvent, ledgerFilePath } from "../missions/ledger";
import { createReportService } from "../missions/reports";
import type { Mission, MissionState } from "../missions/schema";
import { createMissionStore, missionDirectory } from "../missions/store";
import { canTransitionMissionState } from "../missions/state-machine";
import { createToolRunner } from "../tools/runner";

const NODE_UNDERSTAND_GOAL = "n_001_understand_goal";
const NODE_INSPECT_WORKSPACE = "n_002_inspect_workspace";
const NODE_GATHER_CONTEXT = "n_003_gather_context";
const NODE_PROPOSE_ACTION = "n_004_propose_artifact_or_action";
const NODE_REQUEST_APPROVAL = "n_005_request_approval";
const NODE_GENERATE_REPORT = "n_006_generate_report";
const EXECUTOR_REPORT_MARKER = "Phase 13 executor approval artifact";

export type ExecutorStatus = "completed" | "paused_for_approval" | "already_completed" | "paused";

export interface ExecutorResult {
  status: ExecutorStatus;
  missionId: string;
  output: string;
  approvalId?: string;
  reportPath?: string;
}

export function createMissionExecutor(cwd = process.cwd()) {
  const paths = resolveWorkspacePaths(cwd);
  const missionStore = createMissionStore(cwd);
  const approvalStore = createApprovalStore(cwd);
  const toolRunner = createToolRunner({ cwd });
  const reportService = createReportService(cwd);

  return {
    async runMission(missionId: string): Promise<ExecutorResult> {
      return runExecutor(missionId, false);
    },

    async resumeMission(missionId: string): Promise<ExecutorResult> {
      return runExecutor(missionId, true);
    },

    async pauseMission(missionId: string): Promise<ExecutorResult> {
      const mission = await missionStore.readMission(missionId);
      if (mission.state !== "running" && mission.state !== "waiting_for_approval") {
        throw new Error(`Mission ${missionId} cannot be paused from state ${mission.state}.`);
      }

      const updated = await missionStore.updateMissionState(missionId, "paused");
      return {
        status: "paused",
        missionId,
        output: `Mission paused: ${updated.id}\nstate: ${updated.state}\n`
      };
    }
  };

  async function runExecutor(missionId: string, fromResume: boolean): Promise<ExecutorResult> {
    const lines = [`Mission executor for ${missionId}`];
    let mission = await missionStore.readMission(missionId);

    if (mission.state === "completed") {
      return {
        status: "already_completed",
        missionId,
        output: `Mission ${missionId} is already completed.\n`
      };
    }

    mission = await prepareMissionForExecution(mission, fromResume, lines);

    await executeCompletedOrPendingSafeNode(missionId, NODE_UNDERSTAND_GOAL, lines, async () => {
      lines.push("Completed node: Understand goal");
    });
    await executeCompletedOrPendingSafeNode(missionId, NODE_INSPECT_WORKSPACE, lines, async () => {
      const result = await toolRunner.runTool({
        missionId,
        toolName: "filesystem.list",
        input: { path: "." }
      });
      if (!result.ok) {
        throw new Error(result.message);
      }
      lines.push("Completed node: Inspect workspace (filesystem.list)");
    });
    await executeCompletedOrPendingSafeNode(missionId, NODE_GATHER_CONTEXT, lines, async () => {
      const result = await toolRunner.runTool({
        missionId,
        toolName: "git.status",
        input: {}
      });
      if (!result.ok) {
        throw new Error(result.message);
      }
      lines.push("Completed node: Gather relevant context (git.status)");
    });
    await executeCompletedOrPendingSafeNode(missionId, NODE_PROPOSE_ACTION, lines, async () => {
      await appendLedgerEvent(ledgerPath(missionId), {
        missionId,
        type: "user.note",
        summary: "Executor proposed a durable report artifact before completing the mission.",
        details: {
          phase: 13,
          proposal: "report.write approval followed by deterministic report generation"
        }
      });
      lines.push("Completed node: Propose artifact/action");
    });

    const approvalResult = await handleApprovalNode(missionId, lines);
    if (approvalResult.status === "paused_for_approval") {
      return approvalResult;
    }

    const finalResult = await handleReportNode(missionId, lines);
    return finalResult;
  }

  async function prepareMissionForExecution(mission: Mission, fromResume: boolean, lines: string[]): Promise<Mission> {
    if (mission.state === "failed") {
      throw new Error(`Mission ${mission.id} is failed. Recovery execution is not implemented in Phase 13.`);
    }

    if (mission.state === "cancelled") {
      throw new Error(`Mission ${mission.id} is cancelled and cannot be executed.`);
    }

    if (mission.state === "created") {
      mission = await transition(mission, "planning", lines);
      mission = await transition(mission, "running", lines);
      return mission;
    }

    if (mission.state === "planning") {
      return transition(mission, "running", lines);
    }

    if (mission.state === "paused") {
      if (!fromResume) {
        throw new Error(`Mission ${mission.id} is paused. Run: narthynx resume ${mission.id}`);
      }
      return transition(mission, "running", lines);
    }

    return mission;
  }

  async function executeCompletedOrPendingSafeNode(
    missionId: string,
    nodeId: string,
    lines: string[],
    action: () => Promise<void>
  ): Promise<void> {
    const node = await readNode(missionId, nodeId);
    if (node.status === "completed") {
      return;
    }

    await startNode(missionId, node);
    try {
      await action();
      await completeNode(missionId, node);
    } catch (error) {
      await failNode(missionId, node, error);
      await failMissionIfRunning(missionId);
      throw error;
    }
  }

  async function handleApprovalNode(missionId: string, lines: string[]): Promise<ExecutorResult | { status: "continue" }> {
    const node = await readNode(missionId, NODE_REQUEST_APPROVAL);
    if (node.status === "completed") {
      return { status: "continue" };
    }

    const approval = await findExecutorApproval(missionId);
    if (approval?.status === "pending") {
      await ensureMissionState(missionId, "waiting_for_approval", lines);
      await setNodeStatus(missionId, node, "blocked");
      lines.push(`Paused for approval: ${approval.id}`);
      lines.push(`Run: narthynx approve ${approval.id}`);
      lines.push(`Then: narthynx resume ${missionId}`);
      return {
        status: "paused_for_approval",
        missionId,
        approvalId: approval.id,
        output: `${lines.join("\n")}\n`
      };
    }

    if (approval?.status === "approved") {
      await ensureMissionState(missionId, "running", lines);
      if (!approval.executedAt) {
        const continuation = await toolRunner.runApprovedTool(approval.id);
        if (!continuation.ok) {
          throw new Error(continuation.message);
        }
      }
      await completeNode(missionId, node);
      lines.push(`Completed node: Request approval before writing (${approval.id} approved)`);
      return { status: "continue" };
    }

    if (approval?.status === "denied") {
      await ensureMissionState(missionId, "running", lines);
      await completeNode(missionId, node);
      lines.push(`Completed node: Request approval before writing (${approval.id} denied)`);
      return { status: "continue" };
    }

    await startNode(missionId, node);
    const requested = await toolRunner.runTool({
      missionId,
      toolName: "report.write",
      input: {
        path: "report.md",
        content: renderApprovalReportDraft(missionId)
      }
    });

    if (requested.ok) {
      await completeNode(missionId, node);
      lines.push("Completed node: Request approval before writing");
      return { status: "continue" };
    }

    if (!requested.approvalId) {
      await failNode(missionId, node, new Error(requested.message));
      await failMissionIfRunning(missionId);
      throw new Error(requested.message);
    }

    await setNodeStatus(missionId, node, "blocked");
    await ensureMissionState(missionId, "waiting_for_approval", lines);
    lines.push(`Paused for approval: ${requested.approvalId}`);
    lines.push(`Run: narthynx approve ${requested.approvalId}`);
    lines.push(`Then: narthynx resume ${missionId}`);

    return {
      status: "paused_for_approval",
      missionId,
      approvalId: requested.approvalId,
      output: `${lines.join("\n")}\n`
    };
  }

  async function handleReportNode(missionId: string, lines: string[]): Promise<ExecutorResult> {
    const node = await readNode(missionId, NODE_GENERATE_REPORT);
    if (node.status !== "completed") {
      await startNode(missionId, node);
      await ensureMissionState(missionId, "verifying", lines);
      await completeNode(missionId, node);
      lines.push("Completed node: Generate final report");
    }

    await ensureMissionState(missionId, "completed", lines);
    const report = await reportService.generateMissionReport(missionId);
    lines.push(`Mission completed: ${missionId}`);
    lines.push(`report: ${report.path}`);

    return {
      status: "completed",
      missionId,
      reportPath: report.path,
      output: `${lines.join("\n")}\n`
    };
  }

  async function transition(mission: Mission, state: MissionState, lines: string[]): Promise<Mission> {
    if (mission.state === state) {
      return mission;
    }

    if (!canTransitionMissionState(mission.state, state)) {
      throw new Error(`Mission ${mission.id} cannot transition from ${mission.state} to ${state}.`);
    }

    const updated = await missionStore.updateMissionState(mission.id, state);
    lines.push(`Mission state: ${mission.state} -> ${state}`);
    return updated;
  }

  async function ensureMissionState(missionId: string, state: MissionState, lines: string[]): Promise<void> {
    const mission = await missionStore.readMission(missionId);
    if (mission.state === state) {
      return;
    }

    await transition(mission, state, lines);
  }

  async function startNode(missionId: string, node: MissionNode): Promise<void> {
    if (node.status !== "ready") {
      await setNodeStatus(missionId, node, "ready");
      await appendLedgerEvent(ledgerPath(missionId), {
        missionId,
        type: "node.started",
        summary: `Node started: ${node.title}`,
        details: {
          nodeId: node.id,
          nodeTitle: node.title,
          nodeType: node.type
        }
      });
    }
  }

  async function completeNode(missionId: string, node: MissionNode): Promise<void> {
    const current = await readNode(missionId, node.id);
    if (current.status === "completed") {
      return;
    }

    await setNodeStatus(missionId, current, "completed");
    await appendLedgerEvent(ledgerPath(missionId), {
      missionId,
      type: "node.completed",
      summary: `Node completed: ${current.title}`,
      details: {
        nodeId: current.id,
        nodeTitle: current.title,
        nodeType: current.type
      }
    });
  }

  async function failNode(missionId: string, node: MissionNode, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "Unknown executor failure";
    await setNodeStatus(missionId, node, "failed");
    await appendLedgerEvent(ledgerPath(missionId), {
      missionId,
      type: "node.failed",
      summary: `Node failed: ${node.title}`,
      details: {
        nodeId: node.id,
        nodeTitle: node.title,
        nodeType: node.type,
        message
      }
    });
  }

  async function setNodeStatus(missionId: string, node: MissionNode, status: MissionNodeStatus): Promise<void> {
    if (node.status === status) {
      return;
    }

    await missionStore.updateMissionPlanNodeStatus(missionId, node.id, status);
  }

  async function readNode(missionId: string, nodeId: string): Promise<MissionNode> {
    const graph = await missionStore.ensureMissionPlanGraph(missionId);
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      throw new Error(`Phase 13 executor requires deterministic plan node ${nodeId}.`);
    }

    return node;
  }

  async function findExecutorApproval(missionId: string): Promise<ApprovalRequest | undefined> {
    const approvals = await approvalStore.listMissionApprovals(missionId, { allowMissing: true });
    return approvals
      .filter((approval) => approval.toolName === "report.write" && isExecutorReportInput(approval.toolInput))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  async function failMissionIfRunning(missionId: string): Promise<void> {
    const mission = await missionStore.readMission(missionId);
    if (mission.state === "running") {
      await missionStore.updateMissionState(missionId, "failed");
    }
  }

  function ledgerPath(missionId: string): string {
    return ledgerFilePath(missionDirectory(paths.missionsDir, missionId));
  }
}

function isExecutorReportInput(input: unknown): boolean {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const value = input as { path?: unknown; content?: unknown };
  return value.path === "report.md" && typeof value.content === "string" && value.content.includes(EXECUTOR_REPORT_MARKER);
}

function renderApprovalReportDraft(missionId: string): string {
  return [
    "# Mission Execution Approval",
    "",
    EXECUTOR_REPORT_MARKER,
    "",
    `Mission: ${missionId}`,
    "",
    "This approval proves Phase 13 can pause on a gated artifact write and resume after a human decision.",
    "The final deterministic report will be regenerated by the executor after the mission completes."
  ].join("\n");
}
