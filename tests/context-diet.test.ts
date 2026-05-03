import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { createModelPlanner } from "../src/agent/model-planner";
import { createStubModelProvider } from "../src/agent/providers/stub";
import { CONTEXT_DIET_FILE_NAME, WORKSPACE_DIR_NAME } from "../src/config/defaults";
import { initWorkspace, resolveWorkspacePaths } from "../src/config/workspace";
import { createMissionContextService } from "../src/missions/context";
import { buildModelContextPack, pruneStaleContextEntries } from "../src/missions/context-diet";
import { readLedgerEvents } from "../src/missions/ledger";
import { createMissionStore, missionDirectory } from "../src/missions/store";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-diet-"));
}

describe("context diet engine", () => {
  it("respects pack_max_bytes with deterministic omissions", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    await writeFile(
      path.join(cwd, WORKSPACE_DIR_NAME, CONTEXT_DIET_FILE_NAME),
      YAML.stringify({ pack_max_bytes: 4096, pack_max_estimated_tokens: 10_000 }),
      "utf8"
    );
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "g" });
    const ctx = createMissionContextService(cwd);
    await ctx.addNote(mission.id, "a".repeat(2500));
    await ctx.addNote(mission.id, "b".repeat(2500));

    const pack = await buildModelContextPack(mission.id, cwd, { recordLedger: false });
    expect(pack.totals.bytes).toBeLessThanOrEqual(4096);
    expect(pack.entries.some((e) => e.omittedReason === "pack_max_bytes")).toBe(true);
  });

  it("omits stale files when stale_policy is omit_from_pack", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    await writeFile(
      path.join(cwd, WORKSPACE_DIR_NAME, CONTEXT_DIET_FILE_NAME),
      YAML.stringify({ stale_policy: "omit_from_pack" }),
      "utf8"
    );
    const f = path.join(cwd, "drift.md");
    await writeFile(f, "v1\n", "utf8");
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "g" });
    const ctx = createMissionContextService(cwd);
    await ctx.addFile(mission.id, "drift.md", "reason");
    await writeFile(f, "v2-changed\n", "utf8");

    const pack = await buildModelContextPack(mission.id, cwd, { recordLedger: false });
    expect(pack.entries.some((e) => e.omittedReason === "stale_file_omitted")).toBe(true);
  });

  it("dedupes identical file content so pack includes unique body once", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    await writeFile(path.join(cwd, "a.txt"), "same\n", "utf8");
    await writeFile(path.join(cwd, "b.txt"), "same\n", "utf8");
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "g" });
    const ctx = createMissionContextService(cwd);
    await ctx.addFile(mission.id, "a.txt", "r1");
    await ctx.addFile(mission.id, "b.txt", "r2");

    const pack = await buildModelContextPack(mission.id, cwd, { recordLedger: false });
    const bodyHits = pack.packText.split("same").length - 1;
    expect(bodyHits).toBeLessThanOrEqual(1);
  });

  it("records context.pack_built on pack when recordLedger is true", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "g" });
    await createMissionContextService(cwd).addNote(mission.id, "hello");

    await buildModelContextPack(mission.id, cwd, { recordLedger: true });
    const paths = resolveWorkspacePaths(cwd);
    const ledgerPath = path.join(missionDirectory(paths.missionsDir, mission.id), "ledger.jsonl");
    const events = await readLedgerEvents(ledgerPath, { allowMissing: false });
    expect(events.some((e) => e.type === "context.packet_logged")).toBe(true);
    expect(events.some((e) => e.type === "context.pack_built")).toBe(true);
  });

  it("prune-stale removes stale file rows from index", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const f = path.join(cwd, "x.md");
    await writeFile(f, "x\n", "utf8");
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "g" });
    await createMissionContextService(cwd).addFile(mission.id, "x.md", "r");
    await writeFile(f, "y\n", "utf8");

    const n = await pruneStaleContextEntries(mission.id, cwd);
    expect(n).toBeGreaterThan(0);
    const idx = JSON.parse(
      await readFile(path.join(cwd, ".narthynx", "missions", mission.id, "context.json"), "utf8")
    ) as { entries: unknown[] };
    expect(idx.entries.length).toBe(0);
  });
});

describe("model planner and context pack policy", () => {
  it("does not attach pack when cloud_model_sensitive_context is block", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const policyPath = path.join(cwd, WORKSPACE_DIR_NAME, "policy.yaml");
    const raw = await readFile(policyPath, "utf8");
    const policy = YAML.parse(raw) as Record<string, unknown>;
    policy.cloud_model_sensitive_context = "block";
    await writeFile(policyPath, YAML.stringify(policy), "utf8");

    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "Goal" });
    await createMissionContextService(cwd).addNote(mission.id, "secret context note");

    const routerSpy = vi.fn();
    const stub = createStubModelProvider();
    const planner = createModelPlanner(cwd, {
      provider: {
        name: "stub",
        model: "stub-1",
        isNetworked: false,
        async call(req) {
          routerSpy(req.input);
          return stub.call(req);
        }
      }
    });

    await planner.generatePlan(mission.id);

    const input = routerSpy.mock.calls[0][0] as { modelContextPack?: unknown };
    expect(input.modelContextPack).toBeUndefined();
  });

  it("attaches modelContextPack when policy allows sensitive context", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const policyPath = path.join(cwd, WORKSPACE_DIR_NAME, "policy.yaml");
    const raw = await readFile(policyPath, "utf8");
    const policy = YAML.parse(raw) as Record<string, unknown>;
    policy.cloud_model_sensitive_context = "allow";
    await writeFile(policyPath, YAML.stringify(policy), "utf8");

    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "Goal" });
    await createMissionContextService(cwd).addNote(mission.id, "context for plan");

    const routerSpy = vi.fn();
    const stub = createStubModelProvider();
    const planner = createModelPlanner(cwd, {
      provider: {
        name: "stub",
        model: "stub-1",
        isNetworked: false,
        async call(req) {
          routerSpy(req);
          return stub.call(req);
        }
      }
    });

    await planner.generatePlan(mission.id);

    const req = routerSpy.mock.calls[0][0] as {
      input: { modelContextPack?: { text: string } };
      sensitiveContextIncluded: boolean;
    };
    expect(req.input.modelContextPack?.text).toContain("context for plan");
    expect(req.sensitiveContextIncluded).toBe(false);
  });
});
