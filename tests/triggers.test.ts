import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initWorkspace, resolveWorkspacePaths } from "../src/config/workspace";
import { createCockpitApp } from "../src/cockpit/app";
import { ingestTriggerEvent, replayTriggerByEventId } from "../src/triggers/engine";
import { readTriggerLogLines } from "../src/triggers/event-log";
import { validateTriggersYamlText } from "../src/triggers/rules";
import { triggersRulesPath } from "../src/triggers/paths";
import { verifyGithubWebhookSignature } from "../src/triggers/github-signature";
import { MAX_GITHUB_WEBHOOK_BYTES } from "../src/triggers/http-github";

const SAMPLE_TRIGGERS = `version: 1
rules:
  - id: issue-opened-bug
    source: github
    match:
      event: issues
      action: opened
      repository: acme/widget
    action:
      type: create_mission
      template: bug-investigation
      goalTemplate: "Issue #{{ issue.number }}: {{ issue.title }}"
    dedupKeyFrom:
      - "{{ rule.id }}"
      - "{{ issue.number }}"
`;

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "narthynx-triggers-"));
}

function githubSig(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("trigger rules YAML", () => {
  it("accepts valid triggers config", () => {
    const r = validateTriggersYamlText(SAMPLE_TRIGGERS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.rules).toHaveLength(1);
      expect(r.config.rules[0].id).toBe("issue-opened-bug");
    }
  });

  it("rejects rule with neither template nor goalTemplate", () => {
    const bad = `version: 1
rules:
  - id: x
    source: github
    match: {}
    action:
      type: create_mission
    dedupKeyFrom:
      - "k"
`;
    const r = validateTriggersYamlText(bad);
    expect(r.ok).toBe(false);
  });
});

describe("TriggerEngine ingest", () => {
  it("errors when triggers.yaml is missing", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const res = await ingestTriggerEvent(cwd, {
      source: "github",
      rawBody: "{}",
      parsedJson: {},
      githubEventName: "issues"
    });
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("error");
  });

  it("returns no_match when no rule matches", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    await writeFile(triggersRulesPath(paths), SAMPLE_TRIGGERS, "utf8");

    const res = await ingestTriggerEvent(cwd, {
      source: "github",
      rawBody: '{"action":"opened"}',
      parsedJson: {
        action: "opened",
        repository: { full_name: "other/repo" },
        issue: { number: 1, title: "x" }
      },
      githubEventName: "issues"
    });
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("no_match");
  });

  it("creates a mission and records dedup", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    await writeFile(triggersRulesPath(paths), SAMPLE_TRIGGERS, "utf8");

    const rawObj = {
      action: "opened",
      repository: { full_name: "acme/widget" },
      issue: { number: 42, title: "Null deref" }
    };
    const rawBody = JSON.stringify(rawObj);

    const res = await ingestTriggerEvent(cwd, {
      source: "github",
      rawBody,
      parsedJson: rawObj,
      githubEventName: "issues"
    });

    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("matched");
    expect(res.missionId).toMatch(/^m_/);
    expect(res.ruleId).toBe("issue-opened-bug");

    const second = await ingestTriggerEvent(cwd, {
      source: "github",
      rawBody,
      parsedJson: rawObj,
      githubEventName: "issues"
    });
    expect(second.ok).toBe(true);
    expect(second.outcome).toBe("dedup_skip");
    expect(second.missionId).toBe(res.missionId);

    const log = await readTriggerLogLines(paths);
    expect(log.some((l) => l.outcome === "matched")).toBe(true);
    expect(log.some((l) => l.outcome === "dedup_skip")).toBe(true);
  });

  it("dry_run does not create a mission", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    await writeFile(triggersRulesPath(paths), SAMPLE_TRIGGERS, "utf8");

    const rawObj = {
      action: "opened",
      repository: { full_name: "acme/widget" },
      issue: { number: 99, title: "Dry" }
    };
    const rawBody = JSON.stringify(rawObj);

    const res = await ingestTriggerEvent(cwd, {
      source: "github",
      rawBody,
      parsedJson: rawObj,
      githubEventName: "issues",
      dryRun: true
    });
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("dry_run");
    expect(res.missionId).toBeUndefined();
  });

  it("replay re-ingests stored payload", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    await writeFile(triggersRulesPath(paths), SAMPLE_TRIGGERS, "utf8");

    const rawObj = {
      action: "opened",
      repository: { full_name: "acme/widget" },
      issue: { number: 7, title: "Replay me" }
    };
    const rawBody = JSON.stringify(rawObj);

    const first = await ingestTriggerEvent(cwd, {
      source: "github",
      rawBody,
      parsedJson: rawObj,
      githubEventName: "issues"
    });
    expect(first.eventId).toBeDefined();

    const replay = await replayTriggerByEventId(cwd, first.eventId, { force: false });
    expect(replay.outcome).toBe("dedup_skip");

    const replayForce = await replayTriggerByEventId(cwd, first.eventId, { force: true });
    expect(replayForce.outcome).toBe("matched");
    expect(replayForce.missionId).not.toBe(first.missionId);
  });
});

describe("GitHub webhook signature", () => {
  it("accepts matching HMAC", () => {
    const body = '{"x":1}';
    const secret = "s3cret";
    expect(verifyGithubWebhookSignature(body, githubSig(body, secret), secret)).toBe(true);
  });

  it("rejects wrong secret or malformed header", () => {
    const body = '{"x":1}';
    expect(verifyGithubWebhookSignature(body, "sha256=abc", "secret")).toBe(false);
    expect(verifyGithubWebhookSignature(body, undefined, "secret")).toBe(false);
  });
});

describe("Cockpit GitHub trigger webhook", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function cockpitWithSecret(cwd: string, secret: string) {
    const staticRoot = path.join(cwd, "spa");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><html></html>", "utf8");
    return createCockpitApp({
      cwd,
      staticRoot,
      bearerToken: "tok",
      allowLan: false,
      githubWebhookSecret: secret
    });
  }

  it("returns 503 when webhook secret is not configured", async () => {
    vi.stubEnv("NARTHYNX_TRIGGER_GITHUB_SECRET", "");
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const app = await cockpitWithSecret(cwd, "");
    const res = await app.request("http://localhost/api/triggers/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    expect(res.status).toBe(503);
  });

  it("returns 401 when signature is invalid", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const app = await cockpitWithSecret(cwd, "whsec-test");
    const body = JSON.stringify({ hello: "world" });
    const res = await app.request("http://localhost/api/triggers/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        "X-GitHub-Event": "issues"
      },
      body
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 and ingest result when signature is valid", async () => {
    const cwd = await tempWorkspace();
    await initWorkspace(cwd);
    const paths = resolveWorkspacePaths(cwd);
    await writeFile(triggersRulesPath(paths), SAMPLE_TRIGGERS, "utf8");

    const secret = "whsec-integration";
    const app = await cockpitWithSecret(cwd, secret);

    const rawObj = {
      action: "opened",
      repository: { full_name: "acme/widget" },
      issue: { number: 100, title: "From webhook" }
    };
    const body = JSON.stringify(rawObj);
    const res = await app.request("http://localhost/api/triggers/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": githubSig(body, secret),
        "X-GitHub-Event": "issues"
      },
      body
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; outcome: string; missionId?: string };
    expect(json.ok).toBe(true);
    expect(json.outcome).toBe("matched");
    expect(json.missionId).toMatch(/^m_/);
  });
});

describe("GitHub webhook body limit", () => {
  it("exports a bounded max size constant", () => {
    expect(MAX_GITHUB_WEBHOOK_BYTES).toBe(512 * 1024);
  });
});
