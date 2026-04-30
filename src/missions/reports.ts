import { readFile } from "node:fs/promises";
import path from "node:path";

import { createApprovalStore } from "./approvals";
import { createArtifactStore, reportArtifactPath, writeReportArtifact, type Artifact } from "./artifacts";
import { readLedgerEvents } from "./ledger";
import { createMissionStore, missionDirectory } from "./store";
import { resolveWorkspacePaths } from "../config/workspace";

export interface ReportResult {
  artifact: Artifact;
  path: string;
  regenerated: boolean;
}

export function createReportService(cwd = process.cwd()) {
  const paths = resolveWorkspacePaths(cwd);
  const missionStore = createMissionStore(cwd);
  const artifactStore = createArtifactStore(cwd);
  const approvalStore = createApprovalStore(cwd);

  return {
    async generateMissionReport(missionId: string): Promise<ReportResult> {
      const mission = await missionStore.readMission(missionId);
      const missionDir = missionDirectory(paths.missionsDir, missionId);
      const graph = await missionStore.readMissionPlanGraph(missionId).catch(() => mission.planGraph);
      const ledger = await readLedgerEvents(path.join(missionDir, "ledger.jsonl"), { allowMissing: true });
      const approvals = await approvalStore.listMissionApprovals(missionId, { allowMissing: true });
      const checkpoints = Array.isArray(mission.checkpoints) ? mission.checkpoints : [];
      const existingArtifacts = await artifactStore.readMissionArtifacts(missionId);
      const markdown = renderReport({
        mission,
        graph,
        ledger,
        approvals,
        checkpoints,
        artifacts: existingArtifacts
      });
      const filePath = await writeReportArtifact(cwd, missionId, markdown);
      const { artifact, regenerated } = await artifactStore.registerReportArtifact({
        missionId,
        title: `${mission.title} report`,
        metadata: {
          bytes: Buffer.byteLength(markdown, "utf8"),
          sections: [
            "goal",
            "success criteria",
            "final status",
            "plan summary",
            "actions performed",
            "approvals requested and outcomes",
            "files/artifacts created",
            "risks encountered",
            "failures/recoveries",
            "limitations",
            "next recommended actions"
          ]
        }
      });
      const finalMarkdown = renderReport({
        mission,
        graph,
        ledger,
        approvals,
        checkpoints,
        artifacts: [...existingArtifacts.filter((candidate) => candidate.id !== artifact.id), artifact]
      });
      await writeReportArtifact(cwd, missionId, finalMarkdown);

      return {
        artifact,
        path: filePath,
        regenerated
      };
    },

    async readReport(missionId: string): Promise<string> {
      return readFile(reportArtifactPath(missionDirectory(paths.missionsDir, missionId)), "utf8");
    }
  };
}

function renderReport(input: {
  mission: Awaited<ReturnType<ReturnType<typeof createMissionStore>["readMission"]>>;
  graph: unknown;
  ledger: Array<{ type: string; timestamp: string; summary: string; details?: Record<string, unknown> }>;
  approvals: Array<{ id: string; toolName: string; status: string; riskLevel: string; createdAt: string; decidedAt?: string }>;
  checkpoints: unknown[];
  artifacts: Artifact[];
}): string {
  const nodes = graphNodes(input.graph);
  const actionEvents = input.ledger.filter((event) => event.type.startsWith("tool.") || event.type.startsWith("checkpoint."));
  const failures = input.ledger.filter((event) => event.type.includes("failed") || event.type === "error");
  const reportLines = [
    `# ${input.mission.title}`,
    "",
    "## Goal",
    input.mission.goal,
    "",
    "## Success Criteria",
    ...input.mission.successCriteria.map((criterion) => `- ${criterion}`),
    "",
    "## Final Status",
    `State: ${input.mission.state}`,
    input.mission.state === "completed"
      ? "The mission is marked completed."
      : "The mission is not marked completed yet. This report reflects current persisted state.",
    "",
    "## Plan Summary",
    ...listOrFallback(
      nodes.map((node, index) => `${index + 1}. [${node.type}] ${node.title} - ${node.status}`),
      "No persisted plan graph was available."
    ),
    "",
    "## Actions Performed",
    ...listOrFallback(
      actionEvents.map((event) => `- ${event.timestamp} ${event.type}: ${event.summary}`),
      "No tool or checkpoint actions have been recorded yet."
    ),
    "",
    "## Approvals Requested And Outcomes",
    ...listOrFallback(
      input.approvals.map((approval) => `- ${approval.id}: ${approval.toolName} ${approval.status} (${approval.riskLevel})`),
      "No approvals have been requested."
    ),
    "",
    "## Files/Artifacts Created",
    ...listOrFallback(
      [
        ...input.artifacts.map((artifact) => `- ${artifact.type}: ${artifact.path}`),
        ...input.checkpoints.map((checkpoint) => {
          const value = checkpoint as { id?: string; targetPath?: string };
          return `- checkpoint ${value.id ?? "unknown"}: ${value.targetPath ?? "unknown target"}`;
        })
      ],
      "No artifacts or checkpoints are registered yet."
    ),
    "",
    "## Risks Encountered",
    `Risk profile: ${input.mission.riskProfile.level}`,
    ...input.mission.riskProfile.reasons.map((reason) => `- ${reason}`),
    "",
    "## Failures/Recoveries",
    ...listOrFallback(
      failures.map((event) => `- ${event.timestamp} ${event.type}: ${event.summary}`),
      "No failures or recoveries are recorded."
    ),
    "",
    "## Limitations",
    "- This Phase 8 report is deterministic and local-only; no model-generated analysis is included.",
    "- Mission execution, model routing, raw shell mode, and network behavior are not implemented in this phase.",
    "",
    "## Next Recommended Actions",
    "- Review this report against the mission goal and success criteria.",
    "- Use `narthynx timeline <mission-id>` for the raw append-only event history.",
    "- Use `narthynx replay <mission-id>` for the human-readable mission story.",
    "- Continue with later Narthynx phases for fuller mission execution."
  ];

  return `${reportLines.join("\n")}\n`;
}

function graphNodes(graph: unknown): Array<{ type: string; title: string; status: string }> {
  if (typeof graph !== "object" || graph === null || !("nodes" in graph) || !Array.isArray((graph as { nodes: unknown }).nodes)) {
    return [];
  }

  return (graph as { nodes: unknown[] }).nodes
    .map((node) => {
      if (typeof node !== "object" || node === null) {
        return undefined;
      }
      const value = node as { type?: unknown; title?: unknown; status?: unknown };
      return {
        type: typeof value.type === "string" ? value.type : "unknown",
        title: typeof value.title === "string" ? value.title : "Untitled step",
        status: typeof value.status === "string" ? value.status : "unknown"
      };
    })
    .filter((node): node is { type: string; title: string; status: string } => Boolean(node));
}

function listOrFallback(values: string[], fallback: string): string[] {
  return values.length > 0 ? values : [`- ${fallback}`];
}
