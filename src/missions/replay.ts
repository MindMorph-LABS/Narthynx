import type { LedgerEvent } from "./ledger";
import { createMissionStore } from "./store";

export interface ReplayEntry {
  eventId: string;
  type: LedgerEvent["type"];
  timestamp: string;
  text: string;
}

export interface MissionReplay {
  missionId: string;
  missionTitle: string;
  entries: ReplayEntry[];
}

export function createReplayService(cwd = process.cwd()) {
  const missionStore = createMissionStore(cwd);

  return {
    async renderMissionReplay(missionId: string): Promise<string> {
      const mission = await missionStore.readMission(missionId);
      const ledger = await missionStore.readMissionLedger(missionId);
      const replay = buildMissionReplay({
        missionId: mission.id,
        missionTitle: mission.title,
        ledger
      });

      return renderMissionReplay(replay);
    }
  };
}

export function buildMissionReplay(input: {
  missionId: string;
  missionTitle: string;
  ledger: LedgerEvent[];
}): MissionReplay {
  return {
    missionId: input.missionId,
    missionTitle: input.missionTitle,
    entries: input.ledger.map((event) => ({
      eventId: event.id,
      type: event.type,
      timestamp: event.timestamp,
      text: renderReplayEvent(event)
    }))
  };
}

export function renderMissionReplay(replay: MissionReplay): string {
  const lines = [`Replay for ${replay.missionId}: ${replay.missionTitle}`, ""];

  if (replay.entries.length === 0) {
    lines.push("No ledger events found.");
    return `${lines.join("\n")}\n`;
  }

  for (const [index, entry] of replay.entries.entries()) {
    lines.push(`${index + 1}. ${entry.text}`);
  }

  return `${lines.join("\n")}\n`;
}

export function renderReplayEvent(event: LedgerEvent): string {
  const details = event.details ?? {};

  switch (event.type) {
    case "mission.created":
      return `Mission created: ${stringDetail(details, "title") ?? event.summary}`;
    case "mission.state_changed": {
      const from = stringDetail(details, "from");
      const to = stringDetail(details, "to");
      return from && to ? `Mission state changed: ${from} -> ${to}` : event.summary;
    }
    case "plan.created":
      return renderPlanEvent("Plan created", event);
    case "plan.updated":
      return renderPlanEvent("Plan updated", event);
    case "node.started":
      return renderNamedEvent("Node started", event, "nodeTitle", "nodeId");
    case "node.completed":
      return renderNamedEvent("Node completed", event, "nodeTitle", "nodeId");
    case "node.failed":
      return withMessage(renderNamedEvent("Node failed", event, "nodeTitle", "nodeId"), details);
    case "tool.requested":
      return renderToolEvent("Tool requested", event);
    case "tool.started":
      return renderToolStarted(event);
    case "tool.completed":
      return renderToolCompleted(event);
    case "tool.failed":
      return renderToolFailure(event);
    case "tool.approved":
      return renderToolDecision("Tool approved", event);
    case "tool.denied":
      return renderToolDenied(event);
    case "checkpoint.created":
      return renderCheckpointCreated(event);
    case "artifact.created":
      return renderArtifactCreated(event);
    case "model.called":
      return renderModelCalled(event);
    case "cost.recorded":
      return renderCostRecorded(event);
    case "user.note":
      return renderUserNote(event);
    case "vault.secret_read":
      return renderVaultSecretRead(event);
    case "error":
      return `Error: ${event.summary}`;
    default:
      return event.summary;
  }
}

function renderPlanEvent(label: string, event: LedgerEvent): string {
  const nodeCount = numberDetail(event.details, "nodeCount");
  const edgeCount = numberDetail(event.details, "edgeCount");
  const backfilled = booleanDetail(event.details, "backfilled");

  if (nodeCount === undefined || edgeCount === undefined) {
    return event.summary;
  }

  return `${label}: ${nodeCount} nodes, ${edgeCount} edges${backfilled ? " (backfilled)" : ""}`;
}

function renderNamedEvent(label: string, event: LedgerEvent, primaryKey: string, fallbackKey: string): string {
  const value = stringDetail(event.details, primaryKey) ?? stringDetail(event.details, fallbackKey);
  return value ? `${label}: ${value}` : `${label}: ${event.summary}`;
}

function renderToolEvent(label: string, event: LedgerEvent): string {
  const toolName = stringDetail(event.details, "toolName");
  return toolName ? `${label}: ${toolName}` : `${label}: ${event.summary}`;
}

function renderToolStarted(event: LedgerEvent): string {
  const toolName = stringDetail(event.details, "toolName");
  if (!toolName) {
    return `Tool started: ${event.summary}`;
  }

  const riskLevel = stringDetail(event.details, "riskLevel");
  const sideEffect = stringDetail(event.details, "sideEffect");
  const context = [riskLevel ? `risk=${riskLevel}` : undefined, sideEffect ? `sideEffect=${sideEffect}` : undefined]
    .filter((value): value is string => value !== undefined)
    .join(", ");

  return context.length > 0 ? `Tool started: ${toolName} (${context})` : `Tool started: ${toolName}`;
}

function renderToolCompleted(event: LedgerEvent): string {
  const label = renderToolEvent("Tool completed", event);
  const checkpointId = stringDetail(event.details, "checkpointId");
  return checkpointId ? `${label} (${checkpointId})` : label;
}

function renderToolFailure(event: LedgerEvent): string {
  const blocked = booleanDetail(event.details, "blocked");
  const base = renderToolEvent(blocked ? "Tool blocked" : "Tool failed", event);
  return withMessage(base, event.details);
}

function renderToolDecision(label: string, event: LedgerEvent): string {
  const base = renderToolEvent(label, event);
  const approvalId = stringDetail(event.details, "approvalId");
  const actor = formatActorSuffix(event.details);
  const mid = approvalId ? `${base} (${approvalId})` : base;
  return `${mid}${actor}`;
}

function renderToolDenied(event: LedgerEvent): string {
  const status = stringDetail(event.details, "status");
  if (status === "pending_approval") {
    return renderToolDecision("Approval requested", event);
  }

  return withMessage(renderToolDecision("Tool denied", event), event.details);
}

function renderCheckpointCreated(event: LedgerEvent): string {
  const checkpointId = stringDetail(event.details, "checkpointId");
  const targetPath = stringDetail(event.details, "targetPath");

  if (targetPath && checkpointId) {
    return `Checkpoint created: ${targetPath} (${checkpointId})`;
  }

  if (targetPath) {
    return `Checkpoint created: ${targetPath}`;
  }

  return event.summary;
}

function renderArtifactCreated(event: LedgerEvent): string {
  const path = stringDetail(event.details, "path");
  const artifactId = stringDetail(event.details, "artifactId");
  const regenerated = booleanDetail(event.details, "regenerated");

  if (!path) {
    return event.summary;
  }

  const suffix = [artifactId, regenerated ? "regenerated" : undefined].filter((value): value is string => value !== undefined);
  return suffix.length > 0 ? `Artifact created: ${path} (${suffix.join(", ")})` : `Artifact created: ${path}`;
}

function renderModelCalled(event: LedgerEvent): string {
  const provider = stringDetail(event.details, "provider");
  const model = stringDetail(event.details, "model");
  const purpose = stringDetail(event.details, "purpose");
  const target = [provider, model].filter((value): value is string => value !== undefined).join("/");

  if (target.length === 0) {
    return event.summary;
  }

  return purpose ? `Model called: ${target} for ${purpose}` : `Model called: ${target}`;
}

function renderCostRecorded(event: LedgerEvent): string {
  const provider = stringDetail(event.details, "provider");
  const model = stringDetail(event.details, "model");
  const estimatedCost = numberDetail(event.details, "estimatedCost");
  const target = [provider, model].filter((value): value is string => value !== undefined).join("/");

  if (target.length === 0 && estimatedCost === undefined) {
    return event.summary;
  }

  const cost = estimatedCost === undefined ? "unknown cost" : `$${estimatedCost.toFixed(6)}`;
  return target.length > 0 ? `Cost recorded: ${cost} for ${target}` : `Cost recorded: ${cost}`;
}

function renderUserNote(event: LedgerEvent): string {
  const checkpointId = stringDetail(event.details, "checkpointId");
  const fileRollback = booleanDetail(event.details, "fileRollback");
  const targetPath = stringDetail(event.details, "targetPath");
  const actor = formatActorSuffix(event.details);

  if (checkpointId && fileRollback) {
    return (
      (targetPath ? `Checkpoint rewound: ${targetPath} (${checkpointId})` : `Checkpoint rewound: ${checkpointId}`) + actor
    );
  }

  return `User note: ${event.summary}${actor}`;
}

function renderVaultSecretRead(event: LedgerEvent): string {
  const fp = stringDetail(event.details, "entryFingerprint");
  return fp ? `Vault secret read (redacted; fingerprint ${fp})` : "Vault secret read (redacted)";
}

function formatActorSuffix(details: Record<string, unknown> | undefined): string {
  const actor = details?.actor;
  if (!actor || typeof actor !== "object") {
    return "";
  }
  const rec = actor as Record<string, unknown>;
  const id = rec.id;
  if (typeof id !== "string" || id.length === 0) {
    return "";
  }
  const dn = rec.displayName;
  const label = typeof dn === "string" && dn.length > 0 ? `${dn} (${id})` : id;
  return ` by ${label}`;
}

function withMessage(base: string, details: Record<string, unknown> | undefined): string {
  const message = stringDetail(details, "message") ?? stringDetail(details, "reason");
  return message ? `${base} - ${message}` : base;
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanDetail(details: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = details?.[key];
  return typeof value === "boolean" ? value : undefined;
}
