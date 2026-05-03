import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { createMissionStore } from "../missions/store";
import { createStubModelProvider } from "../agent/providers/stub";
import type { ApprovalStore } from "../missions/approvals";
import { createModelRouter } from "../agent/model-router";
import { approvedMemorySnippetForModel } from "../memory/retrieval";
import { appendPendingMemoryProposal } from "../memory/relationship-memory";
import { ensureCompanionHostMissionId } from "./host-mission";
import { parseCompanionStructuredOutput } from "./parse-output";
import { loadPersonaOrDefault } from "./persona";
import { recordMissionSuggestionFromModel } from "./mission-suggestions";
import type { CompanionMessage } from "./models";
import { appendCompanionMessage, readCompanionMessages, ensureCompanionDirs } from "./store";

export interface CompanionTurnInput {
  cwd: string;
  sessionId: string;
  userMessage: string;
  approvalStore?: ApprovalStore;
  fetchImpl?: typeof fetch;
}

export interface CompanionTurnResult {
  assistantText: string;
  storedAssistantMessage: CompanionMessage;
  companionHostMissionId: string;
}

import type { WorkspacePaths } from "../config/workspace";

export async function draftMissionGoalFromRecentChat(paths: WorkspacePaths, sessionId: string): Promise<string> {
  const recent = await readCompanionMessages(paths, sessionId, { maxLines: 40 });
  const lines = recent
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-24)
    .map((m) => `${m.role}: ${m.text}`);
  const body = lines.join("\n").trim();
  return body.length > 0
    ? `From companion chat:\n${body}`
    : "Empty companion transcript — chat first, then re-run.";
}

/** Single companion turn — never invokes tool runner; model output must be strict JSON (or falls back safely). */
export async function runCompanionChatTurn(input: CompanionTurnInput): Promise<CompanionTurnResult> {
  const paths = resolveWorkspacePaths(input.cwd);
  await ensureCompanionDirs(paths);

  const policyResult = await loadWorkspacePolicy(paths.policyFile);
  if (!policyResult.ok) {
    throw new Error(`policy.yaml invalid: ${policyResult.message}`);
  }
  const policy = policyResult.value;

  if (policy.companion_mode === "off") {
    throw new Error("Companion mode is disabled (policy companion_mode: off).");
  }
  if ((policy.companion_tools ?? []).length > 0) {
    throw new Error(
      'policy.companion_tools is non-empty but governed companion tools are not implemented in Frontier F17. Set companion_tools to [].'
    );
  }

  const trimmed = input.userMessage.trim();
  await appendCompanionMessage(paths, input.sessionId, { role: "user", text: trimmed });

  const persona = await loadPersonaOrDefault(paths);
  const hostMissionId = await ensureCompanionHostMissionId(input.cwd, paths);
  const recent = await readCompanionMessages(paths, input.sessionId, { maxLines: 40 });
  const memorySnippet = await approvedMemorySnippetForModel(paths, { maxChars: 2048 });

  const useInjectedStub = policy.companion_mode === "local_stub";

  const router = createModelRouter({
    cwd: input.cwd,
    env: process.env,
    fetchImpl: input.fetchImpl,
    approvalStore: input.approvalStore,
    provider: useInjectedStub ? createStubModelProvider() : undefined
  });

  const envelope = {
    personaName: persona.name,
    personaTone: persona.tone,
    personaSafety: persona.safety_appendix ?? "",
    userMessage: trimmed,
    approvedMemorySnippet: memorySnippet,
    recentMessages: recent.map((m) => ({ role: m.role, text: m.text })),
    preamble:
      "You are Narthynx Companion — planning and continuity only; never emit tool calls, shell, or MCP payloads inside JSON aside from proposeMemory/suggestMission fields."
  };

  let rawContent = "";
  try {
    const response = await router.call({
      missionId: hostMissionId,
      task: "companion_chat",
      purpose: `companion.turn session=${input.sessionId}`,
      input: { companionEnvelope: envelope },
      sensitiveContextIncluded: false
    });
    rawContent = response.content;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rawContent = JSON.stringify({
      reply: `Companion model call blocked or failed (${msg}). No tools were invoked. Adjust policy/companion_mode or approve sensitive-context consent if relevant.`
    });
  }

  const parsed = parseCompanionStructuredOutput(rawContent);
  const structured =
    parsed.ok ? parsed.value : { reply: "Companion reply could not be parsed as structured JSON — showing safe fallback.", suggestMission: undefined, proposeMemory: undefined };

  if (structured.suggestMission) {
    await recordMissionSuggestionFromModel(paths, {
      sessionId: input.sessionId,
      title: structured.suggestMission.title,
      goal: structured.suggestMission.goal
    });
  }
  let queuedMemory = false;
  let memoryPersistError: string | undefined;
  if (structured.proposeMemory?.text.trim()) {
    try {
      await appendPendingMemoryProposal(paths, structured.proposeMemory.text.trim(), input.sessionId);
      queuedMemory = true;
    } catch (e) {
      memoryPersistError = e instanceof Error ? e.message : String(e);
    }
  }

  const assistantText =
    structured.reply +
    (structured.suggestMission
      ? `\n\n(Suggested mission recorded — confirm with \`/mission-from-chat create\` or run \`/mission\` manually.)`
      : "") +
    (queuedMemory && !memoryPersistError ? `\n\n(Memory proposal queued pending approval — \`/memory\`.)` : "") +
    (memoryPersistError ? `\n\n(Memory proposal not saved: ${memoryPersistError})` : "");

  const meta = parsed.ok ? { structured: structured, provider: router.describeProvider() } : { fallback: parsed.error ?? "parse", raw: rawContent.slice(0, 4_096) };

  const stored = await appendCompanionMessage(paths, input.sessionId, {
    role: "assistant",
    text: assistantText,
    modelMeta: meta
  });

  return {
    assistantText,
    storedAssistantMessage: stored,
    companionHostMissionId: hostMissionId
  };
}

export async function buildMissionDraftFromCompanionChat(cwd: string, sessionId: string): Promise<string> {
  const paths = resolveWorkspacePaths(cwd);
  return draftMissionGoalFromRecentChat(paths, sessionId);
}

/** Materialize drafted goal as a Narthynx mission (explicit handoff guard). */
export async function materializeCompanionMissionDraft(cwd: string, draftGoal: string): Promise<{ missionId: string }> {
  const store = createMissionStore(cwd);
  const m = await store.createMission({ goal: draftGoal.trim() });
  return { missionId: m.id };
}
