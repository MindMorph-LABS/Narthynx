import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { createModelRouter } from "../src/agent/model-router";
import { ModelProviderError } from "../src/agent/model-provider";
import { CONTEXT_DIET_FILE_NAME, WORKSPACE_DIR_NAME } from "../src/config/defaults";
import { compileContextPacket } from "../src/context/kernel";
import { resolveContextPacketAcrossWorkspace } from "../src/context/inspect";
import { packetArtifactRelativePath } from "../src/context/manifest";
import { initWorkspace, resolveWorkspacePaths } from "../src/config/workspace";
import { createMissionContextService, sha256Utf8, writeMissionContextIndex } from "../src/missions/context";
import { readLedgerEvents } from "../src/missions/ledger";
import { createMissionStore, missionDirectory } from "../src/missions/store";

async function tempWs(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nx-ctx-kernel-"));
}

describe("Frontier F19 context kernel", () => {
  it("excludes deny-listed paths under policy_deny_path and never marks them included with body", async () => {
    const cwd = await tempWs();
    await initWorkspace(cwd);

    const missions = createMissionStore(cwd);
    const mission = await missions.createMission({ goal: "handle secrets safely" });

    const bad = path.join(cwd, "proj_secret_notes.txt");
    await writeFile(bad, "do not leak\n", "utf8");

    const content = await readFile(bad, "utf8");

    await writeMissionContextIndex(cwd, {
      missionId: mission.id,
      entries: [
        {
          type: "file",
          source: "proj_secret_notes.txt",
          reason: "test fixture",
          bytes: Buffer.byteLength(content, "utf8"),
          addedAt: new Date().toISOString(),
          contentSha256: sha256Utf8(content)
        }
      ]
    });

    const { packet } = await compileContextPacket({
      cwd,
      missionId: mission.id,
      trigger: { source: "manual" },
      persist: false
    });

    expect(packet.excluded.some((e) => e.category === "policy_deny_path")).toBe(true);
    expect(packet.items.some((i) => i.kind === "file" && i.label === "proj_secret_notes.txt" && i.included && i.text.length > 0)).toBe(
      false
    );
  });

  it("prefers relevance-matching notes first when budget forces omission", async () => {
    const cwd = await tempWs();
    await initWorkspace(cwd);

    await writeFile(
      path.join(cwd, WORKSPACE_DIR_NAME, CONTEXT_DIET_FILE_NAME),
      YAML.stringify({
        pack_max_bytes: 4096,
        include_workspace_notes: false
      }),
      "utf8"
    );

    const mission = await createMissionStore(cwd).createMission({ goal: "Ship the widget platform" });
    const ctxSvc = createMissionContextService(cwd);

    await ctxSvc.addNote(mission.id, `widget surface area ${"a".repeat(2400)}`);
    await ctxSvc.addNote(mission.id, `unrelated fluff ${"b".repeat(2470)}`);

    const { packet } = await compileContextPacket({
      cwd,
      missionId: mission.id,
      trigger: { source: "manual" },
      persist: false
    });

    expect(packet.items.some((i) => i.kind === "note" && i.included && i.text.includes("widget"))).toBe(true);

    const winner = packet.items.find((i) => i.kind === "note" && i.included && i.text.includes("widget"));
    expect(winner?.reasonIncluded).toContain("keyword_overlap");

    expect(packet.items.some((i) => i.kind === "note" && i.omitReason === "pack_max_bytes")).toBe(true);
  });

  it("persists ledger context.packet_logged with packet id and artifact file", async () => {
    const cwd = await tempWs();
    await initWorkspace(cwd);

    await writeFile(
      path.join(cwd, WORKSPACE_DIR_NAME, CONTEXT_DIET_FILE_NAME),
      YAML.stringify({ pack_max_bytes: 10_240 }),
      "utf8"
    );

    const mission = await createMissionStore(cwd).createMission({ goal: "log packets" });
    await createMissionContextService(cwd).addNote(mission.id, "hello ledger");

    const { packet } = await compileContextPacket({
      cwd,
      missionId: mission.id,
      trigger: { source: "cli" },
      persist: true
    });

    expect(packet.id.startsWith("cpkt_")).toBe(true);

    const paths = resolveWorkspacePaths(cwd);
    const ledgerPath = path.join(missionDirectory(paths.missionsDir, mission.id), "ledger.jsonl");
    const entries = await readLedgerEvents(ledgerPath, { allowMissing: false });
    const pktLine = [...entries].reverse().find((e) => e.type === "context.packet_logged");
    expect(pktLine).toBeDefined();
    expect((pktLine?.details as Record<string, unknown>).packet_id).toBe(packet.id);

    const artifactPath = path.join(missionDirectory(paths.missionsDir, mission.id), ...packetArtifactRelativePath(packet.id).split("/"));

    expect(JSON.parse(await readFile(artifactPath, "utf8")).id).toBe(packet.id);
  });

  it("computes compressionRatio metadata on truncated inclusive notes under truncation caps", async () => {
    const cwd = await tempWs();
    await initWorkspace(cwd);

    await writeFile(
      path.join(cwd, WORKSPACE_DIR_NAME, CONTEXT_DIET_FILE_NAME),
      YAML.stringify({
        pack_max_bytes: 200_000,
        pack_max_estimated_tokens: 200_000,
        file_truncation: { max_bytes: 2048, head_lines: 1, tail_lines: 0 }
      }),
      "utf8"
    );

    const mission = await createMissionStore(cwd).createMission({ goal: "budget smoke" });

    await createMissionContextService(cwd).addNote(mission.id, [...Array.from({ length: 400 })].map(() => "x".repeat(60)).join("\n"));

    const { packet } = await compileContextPacket({
      cwd,
      missionId: mission.id,
      trigger: { source: "manual" },
      persist: false
    });

    const inc = packet.items.find((i) => i.kind === "note" && i.included && i.text.length > 0);
    expect(inc).toBeDefined();
    expect(inc?.compressionRatio).toBeDefined();
    expect(inc!.compressionRatio!).toBeLessThanOrEqual(1);
    expect(inc!.includedBytes!).toBeLessThan(inc!.originalBytes!);
  });

  it("loads packets via resolveContextPacketAcrossWorkspace hints", async () => {
    const cwd = await tempWs();
    await initWorkspace(cwd);

    const mission = await createMissionStore(cwd).createMission({ goal: "resolve" });

    const { packet } = await compileContextPacket({
      cwd,
      missionId: mission.id,
      trigger: { source: "cli" },
      persist: true
    });

    const found = await resolveContextPacketAcrossWorkspace(cwd, packet.id, mission.id);

    expect(found?.packet.id).toBe(packet.id);
    expect(found?.missionId).toBe(mission.id);
  });

  it("surfaces exclusion counts inside sensitive consent approvals via packSummary metadata", async () => {
    const cwd = await tempWs();
    await initWorkspace(cwd);

    const policyRaw = YAML.parse(await readFile(path.join(cwd, WORKSPACE_DIR_NAME, "policy.yaml"), "utf8")) as Record<string, unknown>;
    policyRaw.allow_network = true;
    policyRaw.cloud_model_sensitive_context = "ask";
    await writeFile(path.join(cwd, WORKSPACE_DIR_NAME, "policy.yaml"), `${YAML.stringify(policyRaw)}\n`, "utf8");

    const mission = await createMissionStore(cwd).createMission({ goal: "consent telemetry" });

    const { createApprovalStore } = await import("../src/missions/approvals");

    const approvalStore = createApprovalStore(cwd);

    const provider = {
      name: "fake",
      model: "fake-model",
      isNetworked: true,
      async call() {
        return {
          provider: "fake",
          model: "fake-model",
          content: "{}",
          latencyMs: 1
        };
      }
    };

    const router = createModelRouter({ cwd, provider, approvalStore });

    const rejection = router.call({
      missionId: mission.id,
      task: "planning",
      purpose: "mission planning",
      sensitiveContextIncluded: true,
      input: {
        modelContextPack: {
          text: "redacted-sample",
          totals: { bytes: 12, estimatedTokens: 3, includedCount: 1 },
          sensitiveContextIncluded: true,
          contextPacketId: "cpkt_fixture",
          exclusionCounts: { policy_deny_path: 3 }
        }
      }
    });
    await expect(rejection).rejects.toMatchObject({ code: "sensitive_requires_approval" });

    const pending = await approvalStore.listPendingApprovals();
    const toolInput = pending[0]?.toolInput as Record<string, unknown>;

    expect((toolInput?.packSummary as Record<string, unknown>).contextPacketId).toBe("cpkt_fixture");
    expect((toolInput?.packSummary as Record<string, unknown>).exclusionCounts).toEqual({ policy_deny_path: 3 });
  });

  it("fails-closed when cloud routing cannot obtain approval metadata", async () => {
    const cwd = await tempWs();
    await initWorkspace(cwd);

    const policyRaw = YAML.parse(await readFile(path.join(cwd, WORKSPACE_DIR_NAME, "policy.yaml"), "utf8")) as Record<string, unknown>;
    policyRaw.allow_network = true;
    policyRaw.cloud_model_sensitive_context = "ask";
    await writeFile(path.join(cwd, WORKSPACE_DIR_NAME, "policy.yaml"), `${YAML.stringify(policyRaw)}\n`, "utf8");

    const mission = await createMissionStore(cwd).createMission({ goal: "gate" });

    const provider = {
      name: "fake",
      model: "fake-model",
      isNetworked: true,
      async call() {
        return {
          provider: "fake",
          model: "fake-model",
          content: "{}",
          latencyMs: 1
        };
      }
    };

    const router = createModelRouter({ cwd, provider }); // intentional: no approvals store helper

    const rejection = router.call({
      missionId: mission.id,
      task: "planning",
      purpose: "mission planning",
      sensitiveContextIncluded: true,
      input: {}
    });

    await expect(rejection).rejects.toThrow(ModelProviderError);
  });
});
