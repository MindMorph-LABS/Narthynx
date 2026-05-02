import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createApprovalStore } from "./approvals";
import { createArtifactStore, artifactsDirPath, type Artifact } from "./artifacts";
import { readLedgerEvents } from "./ledger";
import { createMissionStore, missionDirectory } from "./store";
import { resolveWorkspacePaths } from "../config/workspace";

const PROOF_CARD_RELATIVE_PATH = "artifacts/proof-card.md";

export interface ProofCardResult {
  artifact: Artifact;
  path: string;
  regenerated: boolean;
}

export function createProofCardService(cwd = process.cwd()) {
  const paths = resolveWorkspacePaths(cwd);
  const missionStore = createMissionStore(cwd);
  const approvalStore = createApprovalStore(cwd);
  const artifactStore = createArtifactStore(cwd);

  return {
    async generateProofCard(missionId: string): Promise<ProofCardResult> {
      const mission = await missionStore.readMission(missionId);
      const missionDir = missionDirectory(paths.missionsDir, missionId);
      const ledger = await readLedgerEvents(path.join(missionDir, "ledger.jsonl"), { allowMissing: true });
      const approvals = await approvalStore.listMissionApprovals(missionId, { allowMissing: true });
      const artifacts = await artifactStore.readMissionArtifacts(missionId);
      const markdown = [
        `# Proof Card: ${mission.title}`,
        "",
        `Mission: ${mission.id}`,
        `State: ${mission.state}`,
        `Risk: ${mission.riskProfile.level}`,
        "",
        "## Goal",
        mission.goal,
        "",
        "## Key Actions",
        ...listOrFallback(
          ledger
            .filter((event) => event.type.startsWith("node.") || event.type.startsWith("tool.") || event.type === "mission.state_changed")
            .slice(-12)
            .map((event) => `- ${event.type}: ${event.summary}`),
          "No actions recorded yet."
        ),
        "",
        "## Approvals",
        ...listOrFallback(
          approvals.map((approval) => `- ${approval.id}: ${approval.toolName} ${approval.status} (${approval.riskLevel})`),
          "No approvals requested."
        ),
        "",
        "## Artifacts",
        ...listOrFallback(
          artifacts.map((artifact) => `- ${artifact.type}: ${artifact.path}`),
          "No artifacts registered yet."
        ),
        "",
        "## Risks And Limitations",
        ...mission.riskProfile.reasons.map((reason) => `- ${reason}`),
        "- Proof cards are local Markdown artifacts, not hosted share links.",
        "- Review the full report and replay before treating a mission as externally verified.",
        "",
        "## Verification Paths",
        `- Report: narthynx report ${mission.id}`,
        `- Replay: narthynx replay ${mission.id}`,
        `- Timeline: narthynx timeline ${mission.id}`
      ].join("\n");

      const filePath = path.join(artifactsDirPath(missionDir), "proof-card.md");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${markdown}\n`, "utf8");
      const { artifact, regenerated } = await artifactStore.registerArtifact({
        missionId,
        type: "proof_card",
        title: `${mission.title} proof card`,
        relativePath: PROOF_CARD_RELATIVE_PATH,
        metadata: {
          bytes: Buffer.byteLength(markdown, "utf8"),
          state: mission.state
        }
      });

      return {
        artifact,
        path: filePath,
        regenerated
      };
    },

    async readProofCard(missionId: string): Promise<string> {
      return readFile(path.join(artifactsDirPath(missionDirectory(paths.missionsDir, missionId)), "proof-card.md"), "utf8");
    }
  };
}

function listOrFallback(values: string[], fallback: string): string[] {
  return values.length > 0 ? values : [`- ${fallback}`];
}
