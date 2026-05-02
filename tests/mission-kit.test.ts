import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { initWorkspace } from "../src/config/workspace";
import { createMissionContextService } from "../src/missions/context";
import { createProofCardService } from "../src/missions/proof-card";
import { createMissionStore } from "../src/missions/store";
import { createMissionInputFromTemplate, getMissionTemplate, listMissionTemplates } from "../src/missions/templates";

async function tempWorkspaceRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-mission-kit-"));
}

describe("mission templates", () => {
  it("lists built-in templates and rejects unknown names", () => {
    const templates = listMissionTemplates();

    expect(templates.map((template) => template.name)).toEqual([
      "bug-investigation",
      "deployment-failure-triage",
      "folder-organizer",
      "launch-readiness-review",
      "research-brief"
    ]);
    expect(getMissionTemplate("bug-investigation").title).toBe("Bug investigation");
    expect(() => getMissionTemplate("unknown")).toThrow("Unknown mission template");
  });

  it("creates normal persisted missions from templates", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const store = createMissionStore(cwd);
    const mission = await store.createMission(createMissionInputFromTemplate("bug-investigation"));
    const ledger = await store.readMissionLedger(mission.id);

    expect(mission.title).toBe("Bug investigation");
    expect(mission.successCriteria).toContain("The reported behavior is captured as a mission goal.");
    expect(mission.riskProfile.level).toBe("low");
    expect(mission.planGraph.nodes).toHaveLength(6);
    expect(ledger.find((event) => event.type === "mission.created")?.details?.templateName).toBe("bug-investigation");
  });
});

describe("mission context diet", () => {
  it("adds notes, mirrors mission context, writes context.md, and records user notes", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "Prepare launch checklist" });
    const context = createMissionContextService(cwd);

    const summary = await context.addNote(mission.id, "Focus on release blockers.");
    const updated = await store.readMission(mission.id);
    const ledger = await store.readMissionLedger(mission.id);
    const contextMarkdown = await readFile(path.join(cwd, ".narthynx", "missions", mission.id, "context.md"), "utf8");

    expect(summary.notes).toBe(1);
    expect(summary.estimatedTokens).toBeGreaterThan(0);
    expect(updated.context.notes).toContain("Focus on release blockers.");
    expect(contextMarkdown).toContain("Focus on release blockers.");
    expect(ledger.map((event) => event.type)).toContain("user.note");
  });

  it("attaches safe files, deduplicates repeated attachments, and blocks secret-like files", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    await writeFile(path.join(cwd, "notes.md"), "safe context\n", "utf8");
    await writeFile(path.join(cwd, ".env"), "TOKEN=secret\n", "utf8");
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "Prepare launch checklist" });
    const context = createMissionContextService(cwd);

    const first = await context.addFile(mission.id, "notes.md", "launch notes");
    const second = await context.addFile(mission.id, "notes.md", "launch notes again");
    const updated = await store.readMission(mission.id);

    expect(first.files).toBe(1);
    expect(second.files).toBe(1);
    expect(updated.context.files).toEqual(["notes.md"]);
    await expect(context.addFile(mission.id, ".env", "secret test")).rejects.toThrow("blocked by policy");
  });
});

describe("proof cards", () => {
  it("generates deterministic local proof card artifacts", async () => {
    const cwd = await tempWorkspaceRoot();
    await initWorkspace(cwd);
    const store = createMissionStore(cwd);
    const mission = await store.createMission({ goal: "Prepare launch checklist" });
    const service = createProofCardService(cwd);

    const result = await service.generateProofCard(mission.id);
    const content = await readFile(result.path, "utf8");
    const updated = await store.readMission(mission.id);
    const ledger = await store.readMissionLedger(mission.id);

    expect(result.artifact.type).toBe("proof_card");
    expect(result.artifact.path).toBe("artifacts/proof-card.md");
    expect(content).toContain(`# Proof Card: ${mission.title}`);
    expect(content).toContain(`Replay: narthynx replay ${mission.id}`);
    expect(updated.artifacts.some((artifact) => JSON.stringify(artifact).includes("proof_card"))).toBe(true);
    expect(ledger.some((event) => event.type === "artifact.created" && event.summary.includes("proof_card"))).toBe(true);
  });
});
