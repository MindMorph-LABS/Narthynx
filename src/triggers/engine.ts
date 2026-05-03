import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveWorkspacePaths } from "../config/workspace";
import { createMissionContextService } from "../missions/context";
import { createMissionStore } from "../missions/store";
import { createMissionInputFromTemplate } from "../missions/templates";
import { createTriggerEventId } from "../utils/ids";
import { readDedupIndex, recordDedup, findDedupMission } from "./dedup";
import { appendTriggerLog, readTriggerLogLines } from "./event-log";
import { triggerInboxFile, TRIGGER_INBOX_DIR, triggersRulesPath } from "./paths";
import { loadTriggersConfig } from "./rules";
import { getPath, renderDedupKey, renderTemplate } from "./template";
import type { TriggerRule } from "./schema";

export type IngestSource = "github" | "manual" | "generic";

export interface IngestPayload {
  source: IngestSource;
  rawBody: string;
  parsedJson: unknown;
  /** GitHub `X-GitHub-Event` header value (e.g. issues). */
  githubEventName?: string;
  explicitDedupKey?: string;
  dryRun?: boolean;
  force?: boolean;
}

export type IngestOutcome = "matched" | "no_match" | "dedup_skip" | "dry_run";

export interface IngestResult {
  ok: boolean;
  eventId: string;
  outcome?: IngestOutcome | "error";
  missionId?: string;
  ruleId?: string;
  message?: string;
  dedupKey?: string;
}

function matchRule(rule: TriggerRule, ctx: Record<string, unknown>): boolean {
  const m = rule.match;
  if (m.event) {
    const ev = String(ctx.eventName ?? "");
    if (ev !== m.event) {
      return false;
    }
  }
  if (m.action) {
    const ac = String(ctx.action ?? "");
    if (ac !== m.action) {
      return false;
    }
  }
  if (m.repository) {
    const full = getPath(ctx, "repository.full_name");
    const fn = full === null || full === undefined ? "" : String(full);
    if (!fn.includes(m.repository)) {
      return false;
    }
  }
  return true;
}

export function buildGithubTemplateContext(payload: Record<string, unknown>, eventName: string): Record<string, unknown> {
  return {
    ...payload,
    eventName
  };
}

function buildContext(payload: IngestPayload): Record<string, unknown> {
  if (payload.source === "github" && payload.parsedJson && typeof payload.parsedJson === "object") {
    const p = payload.parsedJson as Record<string, unknown>;
    return buildGithubTemplateContext(p, payload.githubEventName ?? "unknown");
  }
  if (payload.parsedJson && typeof payload.parsedJson === "object" && !Array.isArray(payload.parsedJson)) {
    return { ...(payload.parsedJson as Record<string, unknown>) };
  }
  return {};
}

export async function ingestTriggerEvent(cwd: string, payload: IngestPayload): Promise<IngestResult> {
  const paths = resolveWorkspacePaths(cwd);
  const now = new Date().toISOString();
  const eventId = createTriggerEventId();
  const payloadSha256 = createHash("sha256").update(payload.rawBody, "utf8").digest("hex");
  const ghMeta = payload.githubEventName ? { githubEventName: payload.githubEventName } : {};

  await mkdir(path.join(paths.workspaceDir, TRIGGER_INBOX_DIR), { recursive: true });
  const inboxAbs = triggerInboxFile(paths, eventId);
  await writeFile(inboxAbs, payload.rawBody, "utf8");
  const payloadRefRelative = path.relative(paths.workspaceDir, inboxAbs).replace(/\\/g, "/");

  const rulesResult = await loadTriggersConfig(paths);
  if (!rulesResult.ok) {
    await appendTriggerLog(paths, {
      eventId,
      receivedAt: now,
      source: payload.source,
      outcome: "error",
      dedupKey: "",
      message: rulesResult.message,
      payloadSha256,
      payloadRef: payloadRefRelative,
      ...ghMeta
    });
    return { ok: false, eventId, outcome: "error", message: rulesResult.message };
  }

  const ctx = buildContext(payload);
  const rules = rulesResult.config.rules.filter((r) => r.enabled !== false && r.source === payload.source);

  let matched: TriggerRule | null = null;
  for (const r of rules) {
    if (matchRule(r, ctx)) {
      matched = r;
      break;
    }
  }

  if (!matched) {
    await appendTriggerLog(paths, {
      eventId,
      receivedAt: now,
      source: payload.source,
      outcome: "no_match",
      dedupKey: "",
      message: "No rule matched",
      payloadSha256,
      payloadRef: payloadRefRelative,
      ...ghMeta
    });
    return { ok: true, eventId, outcome: "no_match" };
  }

  const ruleCtx = { ...ctx, rule: { id: matched.id } };
  const dedupKey =
    payload.explicitDedupKey?.trim() ||
    renderDedupKey(matched.dedupKeyFrom, ruleCtx as Record<string, unknown>).trim();

  if (!dedupKey) {
    await appendTriggerLog(paths, {
      eventId,
      receivedAt: now,
      source: payload.source,
      outcome: "error",
      ruleId: matched.id,
      dedupKey: "",
      message: "dedupKey resolved empty",
      payloadSha256,
      payloadRef: payloadRefRelative,
      ...ghMeta
    });
    return { ok: false, eventId, outcome: "error", message: "dedupKey resolved empty" };
  }

  const index = await readDedupIndex(paths);
  const existing = findDedupMission(index, dedupKey);
  if (existing && !payload.force) {
    await appendTriggerLog(paths, {
      eventId,
      receivedAt: now,
      source: payload.source,
      outcome: "dedup_skip",
      ruleId: matched.id,
      missionId: existing,
      dedupKey,
      message: `Duplicate of mission ${existing}`,
      payloadSha256,
      payloadRef: payloadRefRelative,
      ...ghMeta
    });
    return { ok: true, eventId, outcome: "dedup_skip", missionId: existing, dedupKey };
  }

  if (payload.dryRun) {
    await appendTriggerLog(paths, {
      eventId,
      receivedAt: now,
      source: payload.source,
      outcome: "dry_run",
      ruleId: matched.id,
      dedupKey,
      message: "Dry run — no mission created",
      payloadSha256,
      payloadRef: payloadRefRelative,
      ...ghMeta
    });
    return { ok: true, eventId, outcome: "dry_run", ruleId: matched.id, dedupKey };
  }

  const missionStore = createMissionStore(cwd);
  const contextService = createMissionContextService(cwd);
  const action = matched.action;

  try {
    let mission;
    if (action.template) {
      const goalTpl = action.goalTemplate ?? "{{ rule.id }}";
      const goal = renderTemplate(goalTpl, ruleCtx as Record<string, unknown>).trim() || "Trigger mission";
      mission = await missionStore.createMission(createMissionInputFromTemplate(action.template, goal));
    } else {
      const goalTpl = action.goalTemplate ?? "Trigger mission";
      const goal = renderTemplate(goalTpl, ruleCtx as Record<string, unknown>).trim() || "Trigger mission";
      const title = action.titleTemplate
        ? renderTemplate(action.titleTemplate, ruleCtx as Record<string, unknown>).trim()
        : undefined;
      mission = await missionStore.createMission({ goal, title });
    }

    if (action.appendContextNotes) {
      for (const noteTpl of action.appendContextNotes) {
        const note = renderTemplate(noteTpl, { ...ruleCtx, mission: { id: mission.id } } as Record<string, unknown>);
        if (note.trim()) {
          await contextService.addNote(mission.id, note);
        }
      }
    }

    await recordDedup(paths, dedupKey, mission.id, matched.id, now);
    await appendTriggerLog(paths, {
      eventId,
      receivedAt: now,
      source: payload.source,
      outcome: "matched",
      ruleId: matched.id,
      missionId: mission.id,
      dedupKey,
      payloadSha256,
      payloadRef: payloadRefRelative,
      ...ghMeta
    });
    return { ok: true, eventId, outcome: "matched", missionId: mission.id, ruleId: matched.id, dedupKey };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Mission create failed";
    await appendTriggerLog(paths, {
      eventId,
      receivedAt: now,
      source: payload.source,
      outcome: "error",
      ruleId: matched.id,
      dedupKey,
      message: msg,
      payloadSha256,
      payloadRef: payloadRefRelative,
      ...ghMeta
    });
    return { ok: false, eventId, outcome: "error", message: msg };
  }
}

export async function replayTriggerByEventId(
  cwd: string,
  eventId: string,
  options: { force?: boolean } = {}
): Promise<IngestResult> {
  const paths = resolveWorkspacePaths(cwd);
  const lines = await readTriggerLogLines(paths);
  const prior = lines.find((l) => l.eventId === eventId);
  if (!prior?.payloadRef) {
    return { ok: false, eventId, outcome: "error", message: `Event ${eventId} not found or has no payloadRef` };
  }

  const { readFile } = await import("node:fs/promises");
  const abs = path.join(paths.workspaceDir, prior.payloadRef);
  let rawBody: string;
  try {
    rawBody = await readFile(abs, "utf8");
  } catch {
    return { ok: false, eventId, outcome: "error", message: `Payload file missing: ${prior.payloadRef}` };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return { ok: false, eventId, outcome: "error", message: "Stored payload is not valid JSON" };
  }

  const source = (prior.source as IngestPayload["source"]) || "github";

  return ingestTriggerEvent(cwd, {
    source,
    rawBody,
    parsedJson,
    githubEventName: prior.githubEventName,
    dryRun: false,
    force: options.force === true
  });
}

export function formatTriggersDoctorMessage(paths: ReturnType<typeof resolveWorkspacePaths>): string {
  return `Expected rules file: ${triggersRulesPath(paths)}`;
}
