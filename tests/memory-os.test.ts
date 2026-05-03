import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { DEFAULT_POLICY } from "../src/config/defaults";
import { resolveWorkspacePaths, initWorkspace } from "../src/config/workspace";
import { detectMemoryConflicts } from "../src/memory/conflicts";
import { appendPendingMemoryProposal, approvePendingMemoryProposal } from "../src/memory/relationship-memory";
import { appendApprovedMemory, listApprovedMemory } from "../src/memory/user-memory";
import { buildModelContextPack } from "../src/missions/context-diet";
import { ledgerFilePath } from "../src/missions/ledger";
import { createMissionStore, missionDirectory } from "../src/missions/store";

describe("Frontier F18 Memory OS", () => {
  it("injects active memory into model context packs with ledger memory_item_ids", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nx-f18-pack-"));
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    const mission = await createMissionStore(cwd).createMission({ goal: "memory pack test" });

    await appendApprovedMemory(paths, "User prefers deterministic tests for pack inclusion f18token");

    const pack = await buildModelContextPack(mission.id, cwd);
    const memoryEntries = pack.entries.filter((e) => e.kind === "memory" && e.text.length > 0);
    expect(memoryEntries.length).toBeGreaterThanOrEqual(1);
    expect(memoryEntries.some((e) => e.text.includes("f18token"))).toBe(true);
    expect(pack.totals.memoryItemCount).toBeGreaterThanOrEqual(1);

    const ledgerPath = ledgerFilePath(missionDirectory(paths.missionsDir, mission.id));
    const raw = await readFile(ledgerPath, "utf8");
    const ledgerLines = raw.trim().split(/\r?\n/).filter(Boolean);
    const last = ledgerLines[ledgerLines.length - 1]!;
    const ev = JSON.parse(last) as { type: string; details?: { memory_item_ids?: string[] } };
    expect(ev.type).toBe("context.pack_built");
    expect(ev.details?.memory_item_ids?.length).toBeGreaterThanOrEqual(1);
  });

  it("skips memory sections when policy.memory_storage is off", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nx-f18-off-"));
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    const next = { ...DEFAULT_POLICY, memory_storage: "off" as const };
    await writeFile(paths.policyFile, `${YAML.stringify(next)}\n`, "utf8");

    await expect(appendApprovedMemory(paths, "blocked")).rejects.toThrow();

    const mission = await createMissionStore(cwd).createMission({ goal: "no memory" });
    const pack = await buildModelContextPack(mission.id, cwd);
    expect(pack.entries.filter((e) => e.kind === "memory" && e.text).length).toBe(0);
    expect(pack.totals.memoryItemCount).toBe(0);
  });

  it("relationship proposal approval creates an item visible in listApprovedMemory", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nx-f18-rel-"));
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    const prop = await appendPendingMemoryProposal(paths, "relationship-visible f18rel", "sess");
    await approvePendingMemoryProposal(paths, prop.id);
    const rows = await listApprovedMemory(paths);
    expect(rows.some((r) => r.text.includes("f18rel"))).toBe(true);
  });

  it("detectMemoryConflicts flags highly overlapping but not identical items", () => {
    const makeText = (overrideLast: boolean) =>
      Array.from({ length: 80 }, (_, i) => (overrideLast && i === 79 ? "altwordzzzz" : `token${i}`)).join(" ");
    const a = {
      id: "a1",
      schema: "narthynx.memory.item.v1" as const,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      scope: "user" as const,
      text: makeText(false),
      confidence: 1,
      sensitivity: "none" as const,
      status: "active" as const,
      tags: [],
      source: { kind: "manual" as const }
    };
    const b = {
      ...a,
      id: "b1",
      text: makeText(true)
    };
    const pairs = detectMemoryConflicts([a, b]);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.similarity).toBeGreaterThanOrEqual(0.82);
  });
});
