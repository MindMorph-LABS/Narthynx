import { mkdtemp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import { appendMissionSuggestion } from "../src/companion/store";
import { parseCompanionStructuredOutput } from "../src/companion/parse-output";
import { appendCompanionReminder, peelDueCompanionReminders } from "../src/companion/reminders";
import { deliverDueCompanionReminders } from "../src/companion/reminder-delivery";
import { appendPendingMemoryProposal, approvePendingMemoryProposal, listPendingMemoryProposals } from "../src/memory/relationship-memory";
import { listApprovedMemory } from "../src/memory/user-memory";
import { runCompanionChatTurn } from "../src/companion/chat";
import { resolveWorkspacePaths, initWorkspace } from "../src/config/workspace";
import { acceptLatestProposedMissionSuggestion } from "../src/companion/mission-suggestions";

async function recursiveTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...(await recursiveTs(p)));
    } else if (name.isFile() && name.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("Frontier F17 companion", () => {
  it("parses structured JSON strictly (rejects stray tool keys)", () => {
    const bad = parseCompanionStructuredOutput('{"reply":"ok","invokeShell":["rm -rf /"]}');
    expect(bad.ok).toBe(false);
    const ok = parseCompanionStructuredOutput('{"reply":"hi","suggestMission":{"title":"T","goal":"G"}}');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.suggestMission?.goal).toBe("G");
    }
  });

  it("persists companion messages across turns", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nx-cmp-"));
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);

    await runCompanionChatTurn({
      cwd,
      sessionId: "t1",
      userMessage: "hello from test"
    });
    await runCompanionChatTurn({
      cwd,
      sessionId: "t1",
      userMessage: "second line"
    });

    const raw = await readFile(path.join(paths.companionSessionsDir, "t1", "messages.jsonl"), "utf8");
    expect(raw.split(/\r?\n/).filter(Boolean).length).toBe(4);
  });

  it("creates missions from companion suggestions via acceptLatest", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nx-cmp-"));
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    await appendMissionSuggestion(paths, {
      summary: "S",
      proposedGoal: "Do the thing safely.",
      proposedTitle: "T",
      status: "proposed"
    });
    const accept = await acceptLatestProposedMissionSuggestion(paths, cwd);
    expect("missionId" in accept).toBe(true);
    if ("missionId" in accept) {
      expect(accept.missionId).toMatch(/^m_/);
    }
  });

  it("gates memory proposals behind approval", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nx-mem-"));
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    const p = await appendPendingMemoryProposal(paths, "prefers YAML over JSON for configs", "s");
    expect((await listApprovedMemory(paths)).length).toBe(0);
    await approvePendingMemoryProposal(paths, p.id);
    const stillPendingSameId = await listPendingMemoryProposals(paths);
    expect(stillPendingSameId.every((row) => row.id !== p.id)).toBe(true);
    expect((await listApprovedMemory(paths)).some((r) => r.text.includes("YAML"))).toBe(true);
  });

  it("peels due reminders exactly once", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nx-rem-"));
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    const past = new Date(Date.now() - 60_000).toISOString();
    await appendCompanionReminder(paths, {
      fireAt: past,
      message: "ping",
      status: "pending"
    });
    const first = await peelDueCompanionReminders(paths, Date.now());
    expect(first.length).toBe(1);
    const second = await peelDueCompanionReminders(paths, Date.now());
    expect(second.length).toBe(0);
  });

  it("daemon hook notifies + emits event for peeled reminders", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nx-dmon-"));
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    const past = new Date(Date.now() - 30_000).toISOString();
    await appendCompanionReminder(paths, { fireAt: past, message: "due now", status: "pending" });
    const notify = vi.fn().mockResolvedValue(undefined);
    const append = vi.fn().mockResolvedValue(undefined);
    await deliverDueCompanionReminders(paths, {
      cwd,
      notificationSink: { notify },
      eventBus: { append }
    });
    expect(notify).toHaveBeenCalled();
    expect(append).toHaveBeenCalled();
  });

  it("companion modules do not import mission tool runner", async () => {
    const roots = [path.resolve("src/companion"), path.resolve("src/memory")];
    const files = (await Promise.all(roots.map((r) => recursiveTs(r)))).flat();
    for (const f of files) {
      const text = await readFile(f, "utf8");
      expect(text.includes('from "../tools/runner"') || text.includes('from "../../tools/runner"')).toBe(false);
      expect(text.includes("createToolRunner")).toBe(false);
    }
  });
});
