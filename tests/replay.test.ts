import { describe, expect, it } from "vitest";

import { buildMissionReplay, renderMissionReplay, renderReplayEvent } from "../src/missions/replay";
import type { LedgerEvent } from "../src/missions/ledger";

function event(overrides: Partial<LedgerEvent>): LedgerEvent {
  return {
    id: "e_123e4567-e89b-12d3-a456-426614174000",
    missionId: "m_123e4567-e89b-12d3-a456-426614174000",
    type: "mission.created",
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "Mission created",
    ...overrides
  };
}

describe("mission replay", () => {
  it("renders mission and plan events from structured ledger details", () => {
    const replay = buildMissionReplay({
      missionId: "m_123e4567-e89b-12d3-a456-426614174000",
      missionTitle: "Prepare launch checklist",
      ledger: [
        event({
          type: "mission.created",
          summary: "Mission created: Prepare launch checklist",
          details: {
            title: "Prepare launch checklist"
          }
        }),
        event({
          type: "plan.created",
          summary: "Deterministic MVP plan graph created.",
          details: {
            nodeCount: 6,
            edgeCount: 5
          }
        })
      ]
    });

    expect(renderMissionReplay(replay)).toContain("Replay for m_123e4567-e89b-12d3-a456-426614174000: Prepare launch checklist");
    expect(replay.entries.map((entry) => entry.text)).toEqual([
      "Mission created: Prepare launch checklist",
      "Plan created: 6 nodes, 5 edges"
    ]);
  });

  it("renders approval, checkpoint, tool, artifact, and rewind events", () => {
    const rendered = [
      renderReplayEvent(
        event({
          type: "tool.denied",
          summary: "Tool pending approval: filesystem.write",
          details: {
            toolName: "filesystem.write",
            status: "pending_approval",
            approvalId: "a_123"
          }
        })
      ),
      renderReplayEvent(
        event({
          type: "tool.approved",
          summary: "Tool approved: filesystem.write",
          details: {
            toolName: "filesystem.write",
            approvalId: "a_123"
          }
        })
      ),
      renderReplayEvent(
        event({
          type: "checkpoint.created",
          summary: "Checkpoint created for filesystem.write: launch.md",
          details: {
            checkpointId: "c_123",
            targetPath: "launch.md"
          }
        })
      ),
      renderReplayEvent(
        event({
          type: "tool.completed",
          summary: "Tool completed: filesystem.write",
          details: {
            toolName: "filesystem.write",
            checkpointId: "c_123"
          }
        })
      ),
      renderReplayEvent(
        event({
          type: "artifact.created",
          summary: "Report artifact created: artifacts/report.md",
          details: {
            artifactId: "art_123",
            path: "artifacts/report.md"
          }
        })
      ),
      renderReplayEvent(
        event({
          type: "user.note",
          summary: "Checkpoint rewound: c_123",
          details: {
            checkpointId: "c_123",
            targetPath: "launch.md",
            fileRollback: true
          }
        })
      )
    ];

    expect(rendered).toEqual([
      "Approval requested: filesystem.write (a_123)",
      "Tool approved: filesystem.write (a_123)",
      "Checkpoint created: launch.md (c_123)",
      "Tool completed: filesystem.write (c_123)",
      "Artifact created: artifacts/report.md (art_123)",
      "Checkpoint rewound: launch.md (c_123)"
    ]);
  });

  it("falls back to ledger summaries for sparse future event shapes", () => {
    expect(
      renderReplayEvent(
        event({
          type: "model.called",
          summary: "Model call recorded without structured details."
        })
      )
    ).toBe("Model call recorded without structured details.");
  });
});
