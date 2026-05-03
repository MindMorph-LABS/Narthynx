import { appendLedgerEvent, ledgerFilePath } from "../missions/ledger";
import { createMissionStore, missionDirectory } from "../missions/store";
import { createApprovalStore } from "../missions/approvals";
import { createModelRouter } from "../agent/model-router";
import type { ModelRouter } from "../agent/model-router";
import { createToolRunner } from "../tools/runner";
import type { ToolRunRequest } from "../tools/types";
import { resolveWorkspacePaths } from "../config/workspace";
import { loadSubagentsConfig } from "../config/subagents-config";
import { createSubagentSessionId } from "../utils/ids";

import { planGraphSchema, type PlanGraph } from "../missions/graph";

import { SUBAGENT_PRINCIPAL_PREFIX } from "./schema";

import { SubagentBudget } from "./budget";
import { SubagentTranscript } from "./transcript";
import { classifyToolAgainstProfile } from "./tool-gate";
import { verifyMissionDeterministic } from "./verifier-agent";
import { runSafetyReview } from "./safety-agent";
import { assembleCriticResult } from "./critic-agent";
import { runPlannerDraft } from "./planner-agent";

export type SubagentSessionStatus = "completed" | "failed";

export interface RunSubagentSessionInput {
  cwd: string;
  missionId: string;
  profileId: string;
  router?: ModelRouter;
  approvalStoreProvided?: ReturnType<typeof createApprovalStore>;
  hypotheticalTool?: { toolName: string; toolInput: unknown };
  applyPlanner?: boolean;
  plannerConfirmYes?: boolean;
}

export interface SubagentSessionResult<T = unknown> {
  status: SubagentSessionStatus;
  profileId: string;
  sessionId: string;
  payload?: T;
  error?: string;
  transcriptPreview: Record<string, unknown>;
  budgetUsed: ReturnType<SubagentBudget["snapshot"]>;
}

export async function runSubagentToolGated(input: {
  cwd: string;
  missionId: string;
  profileId: string;
  toolName: string;
  toolInput: unknown;
  budget: SubagentBudget;
  profile: Parameters<typeof classifyToolAgainstProfile>[1];
  ledgerPath: string;
}): Promise<
  | { ok: true; output: unknown }
  | {
      ok: false;
      code: "budget" | "gate";
      reason: string;
    }
> {
  if (!input.budget.canUseTool()) {
    return {
      ok: false,
      code: "budget",
      reason: "maxToolCallsPerSession exhausted"
    };
  }

  const gate = classifyToolAgainstProfile(input.toolName, input.profile);
  if (!gate.ok) {
    await appendLedgerEvent(input.ledgerPath, {
      missionId: input.missionId,
      type: "subagent.tool_blocked",
      summary: `Subagent gated tool ${input.toolName}`,
      details: {
        profileId: input.profileId,
        toolName: input.toolName,
        reason: gate.reason,
        principal: `${SUBAGENT_PRINCIPAL_PREFIX}${input.profileId}`
      }
    });

    return { ok: false, code: "gate", reason: gate.reason };
  }

  if (!input.budget.consumeToolCall()) {
    return { ok: false, code: "budget", reason: "tool budget contention" };
  }

  const runner = createToolRunner({ cwd: input.cwd });
  const request: ToolRunRequest = {
    missionId: input.missionId,
    toolName: input.toolName,
    input: input.toolInput
  };
  const result = await runner.runTool(request);

  if (!result.ok) {
    await appendLedgerEvent(input.ledgerPath, {
      missionId: input.missionId,
      type: "subagent.turn",
      summary: `Subagent tool denied/blocked ${input.toolName}`,
      details: {
        profileId: input.profileId,
        toolName: input.toolName,
        message: result.message,
        principal: `${SUBAGENT_PRINCIPAL_PREFIX}${input.profileId}`
      }
    });
    return { ok: false, code: "gate", reason: result.message };
  }

  await appendLedgerEvent(input.ledgerPath, {
    missionId: input.missionId,
    type: "subagent.turn",
    summary: `Subagent tool completed ${input.toolName}`,
    details: {
      profileId: input.profileId,
      toolName: input.toolName,
      principal: `${SUBAGENT_PRINCIPAL_PREFIX}${input.profileId}`
    }
  });

  return { ok: true, output: result.output };
}

async function finalizeSuccess<T>(
  missionId: string,
  ledgerPath: string,
  profileId: string,
  sessionId: string,
  transcript: SubagentTranscript,
  budget: SubagentBudget,
  payload?: T,
  envelope?: Record<string, unknown>
): Promise<SubagentSessionResult<T>> {
  await appendLedgerEvent(ledgerPath, {
    missionId,
    type: "subagent.completed",
    summary: `Subagent session ${sessionId} completed (${profileId})`,
    details: {
      principal: `${SUBAGENT_PRINCIPAL_PREFIX}${profileId}`,
      session_id: sessionId,
      profileId,
      budget: budget.snapshot(),
      ...(payload !== undefined ? { output: sanitizeSnapshot(payload as unknown) } : {}),
      ...(envelope ?? {})
    }
  });

  return {
    status: "completed",
    profileId,
    sessionId,
    payload,
    transcriptPreview: transcript.sanitizeForLedger(),
    budgetUsed: budget.snapshot()
  };
}

async function finalizeFailure(
  missionId: string,
  ledgerPath: string,
  profileId: string,
  sessionId: string,
  transcript: SubagentTranscript,
  budget: SubagentBudget,
  message: string
): Promise<SubagentSessionResult<never>> {
  await appendLedgerEvent(ledgerPath, {
    missionId,
    type: "subagent.failed",
    summary: message,
    details: {
      principal: `${SUBAGENT_PRINCIPAL_PREFIX}${profileId}`,
      session_id: sessionId,
      profileId,
      budget: budget.snapshot(),
      transcript: transcript.sanitizeForLedger()
    }
  });

  return {
    status: "failed",
    profileId,
    sessionId,
    error: message,
    transcriptPreview: transcript.sanitizeForLedger(),
    budgetUsed: budget.snapshot()
  };
}

function sanitizeSnapshot(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return { note: "(unserializable payload)" };
  }
}

async function resolveMissionPlanGraphSafely(store: ReturnType<typeof createMissionStore>, missionId: string): Promise<PlanGraph | null> {
  try {
    const raw = await store.readMissionPlanGraph(missionId);
    const parsed = planGraphSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function structuredCloneJSON<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export async function runSubagentSession(input: RunSubagentSessionInput): Promise<SubagentSessionResult> {
  const paths = resolveWorkspacePaths(input.cwd);
  const ledgerPathResolved = ledgerFilePath(missionDirectory(paths.missionsDir, input.missionId));
  const configLoad = await loadSubagentsConfig(paths.subagentsFile);
  if (!configLoad.ok) {
    throw new Error(`subagents.yaml invalid: ${configLoad.message}`);
  }

  if (!configLoad.value.enabled) {
    return {
      status: "failed",
      profileId: input.profileId,
      sessionId: "disabled",
      error: "subagents disabled via subagents.yaml",
      transcriptPreview: {},
      budgetUsed: { turnsUsed: 0, toolCallsUsed: 0, modelCallsUsed: 0 }
    };
  }

  const profile = configLoad.value.profiles[input.profileId];
  if (!profile) {
    throw new Error(`unknown subagent profile "${input.profileId}"`);
  }

  const transcript = new SubagentTranscript();
  const budget = new SubagentBudget(profile);

  const store = createMissionStore(input.cwd);
  const mission = await store.readMission(input.missionId);
  let graph = await resolveMissionPlanGraphSafely(store, input.missionId);

  const sessionId = createSubagentSessionId();
  await appendLedgerEvent(ledgerPathResolved, {
    missionId: input.missionId,
    type: "subagent.session_started",
    summary: `Subagent "${input.profileId}" session ${sessionId} (${profile.kind})`,
    details: {
      principal: `${SUBAGENT_PRINCIPAL_PREFIX}${input.profileId}`,
      session_id: sessionId,
      profileId: input.profileId,
      agentKind: profile.kind,
      riskBoundary: profile.riskBoundary
    }
  });

  const router =
    input.router ??
    createModelRouter({
      cwd: input.cwd,
      approvalStore: input.approvalStoreProvided ?? createApprovalStore(input.cwd)
    });

  try {
    switch (profile.kind) {
      case "verifier": {
        if (!budget.consumeTurn()) {
          transcript.pushNote("turn_budget_blocked");
          return finalizeFailure(input.missionId, ledgerPathResolved, input.profileId, sessionId, transcript, budget, "maxTurns exhausted");
        }

        transcript.pushNote("verifier:start");
        const outcome = await verifyMissionDeterministic({
          missionsDir: paths.missionsDir,
          missionId: input.missionId,
          mission,
          graph
        });
        await appendLedgerEvent(ledgerPathResolved, {
          missionId: input.missionId,
          type: "subagent.turn",
          summary: `Verifier finished ok=${outcome.ok}`,
          details: {
            principal: `${SUBAGENT_PRINCIPAL_PREFIX}${input.profileId}`,
            session_id: sessionId,
            profileId: input.profileId,
            checks: outcome.checks.length
          }
        });
        transcript.ledgerHint("subagent.turn");
        return finalizeSuccess(input.missionId, ledgerPathResolved, input.profileId, sessionId, transcript, budget, outcome, {
          verifier_checks: outcome.checks.slice(0, 20).map((c) => c.id)
        });
      }

      case "safety": {
        if (!budget.consumeTurn()) {
          transcript.pushNote("turn_budget_blocked");
          return finalizeFailure(input.missionId, ledgerPathResolved, input.profileId, sessionId, transcript, budget, "maxTurns exhausted");
        }

        if (!input.hypotheticalTool) {
          return finalizeFailure(
            input.missionId,
            ledgerPathResolved,
            input.profileId,
            sessionId,
            transcript,
            budget,
            "safety agent requires hypotheticalTool (--tool / --input-json)."
          );
        }
        await appendLedgerEvent(ledgerPathResolved, {
          missionId: input.missionId,
          type: "subagent.turn",
          summary: `Safety reviewing ${input.hypotheticalTool.toolName}`,
          details: {
            principal: `${SUBAGENT_PRINCIPAL_PREFIX}${input.profileId}`,
            session_id: sessionId,
            toolName: input.hypotheticalTool.toolName
          }
        });
        const reviewed = await runSafetyReview({
          missionId: input.missionId,
          router,
          budget,
          proposedTool: input.hypotheticalTool.toolName,
          proposedInput: input.hypotheticalTool.toolInput
        });
        return finalizeSuccess(
          input.missionId,
          ledgerPathResolved,
          input.profileId,
          sessionId,
          transcript,
          budget,
          reviewed,
          { safety_blocked: reviewed.blocked }
        );
      }

      case "critic": {
        if (!budget.consumeTurn()) {
          transcript.pushNote("turn_budget_blocked");
          return finalizeFailure(input.missionId, ledgerPathResolved, input.profileId, sessionId, transcript, budget, "maxTurns exhausted");
        }

        transcript.pushNote("critic:verifier_phase");
        const verifier = await verifyMissionDeterministic({
          missionsDir: paths.missionsDir,
          missionId: input.missionId,
          mission,
          graph
        });

        let critic;
        const hasHypothesis = Boolean(input.hypotheticalTool?.toolName);

        if (hasHypothesis) {
          if (!budget.consumeTurn()) {
            return finalizeFailure(
              input.missionId,
              ledgerPathResolved,
              input.profileId,
              sessionId,
              transcript,
              budget,
              "maxTurns exhausted before safety critique phase"
            );
          }

          transcript.pushNote("critic:safety_phase");
          await appendLedgerEvent(ledgerPathResolved, {
            missionId: input.missionId,
            type: "subagent.turn",
            summary: `Critic reviewing ${input.hypotheticalTool!.toolName}`,
            details: {
              principal: `${SUBAGENT_PRINCIPAL_PREFIX}${input.profileId}`,
              session_id: sessionId,
              toolName: input.hypotheticalTool!.toolName
            }
          });

          const safety = await runSafetyReview({
            missionId: input.missionId,
            router,
            budget,
            proposedTool: input.hypotheticalTool!.toolName,
            proposedInput: input.hypotheticalTool!.toolInput
          });

          critic = assembleCriticResult(verifier, safety, { safetySkipped: false });
        } else {
          critic = assembleCriticResult(verifier, undefined, { safetySkipped: true });
        }

        await appendLedgerEvent(ledgerPathResolved, {
          missionId: input.missionId,
          type: "subagent.turn",
          summary: `Critic verdict ok=${critic.ok}`,
          details: {
            principal: `${SUBAGENT_PRINCIPAL_PREFIX}${input.profileId}`,
            session_id: sessionId,
            safetySkipped: !hasHypothesis
          }
        });

        return finalizeSuccess(input.missionId, ledgerPathResolved, input.profileId, sessionId, transcript, budget, critic, {
          critic_ok: critic.ok
        });
      }

      case "planner": {
        if (!budget.consumeTurn()) {
          transcript.pushNote("turn_budget_blocked");
          return finalizeFailure(input.missionId, ledgerPathResolved, input.profileId, sessionId, transcript, budget, "maxTurns exhausted");
        }

        if (!graph) {
          const seeded = mission.planGraph;
          const parsedBaseline = seeded ? planGraphSchema.safeParse(seeded) : undefined;
          if (!parsedBaseline?.success) {
            return finalizeFailure(
              input.missionId,
              ledgerPathResolved,
              input.profileId,
              sessionId,
              transcript,
              budget,
              "No valid persisted plan graph baseline found for planner subagent."
            );
          }
          graph = parsedBaseline.data;
        }

        transcript.pushNote("planner:start", { baselineNodes: graph?.nodes.length });
        const baseline = structuredCloneJSON(graph!) as PlanGraph;
        const draft = await runPlannerDraft({
          missionId: input.missionId,
          mission,
          baseline,
          router,
          budget
        });

        if (input.applyPlanner) {
          if (profile.requireExplicitApply && !input.plannerConfirmYes) {
            return finalizeFailure(
              input.missionId,
              ledgerPathResolved,
              input.profileId,
              sessionId,
              transcript,
              budget,
              "Planner persistence requires `--apply --yes` when profile.requireExplicitApply is true."
            );
          }

          await store.updateMissionPlanGraph(input.missionId, draft.proposedGraph, {
            summary: "Plan graph updated by subagent planner (explicit apply)",
            provider: "subagent",
            model: "subagent_planner"
          });
          graph = draft.proposedGraph;
        }

        await appendLedgerEvent(ledgerPathResolved, {
          missionId: input.missionId,
          type: "subagent.turn",
          summary: `Planner draft; applied=${String(Boolean(input.applyPlanner))}`,
          details: {
            principal: `${SUBAGENT_PRINCIPAL_PREFIX}${input.profileId}`,
            session_id: sessionId,
            applied: Boolean(input.applyPlanner),
            rationale_len: draft.rationale.length
          }
        });

        return finalizeSuccess(
          input.missionId,
          ledgerPathResolved,
          input.profileId,
          sessionId,
          transcript,
          budget,
          draft,
          { applied: Boolean(input.applyPlanner) }
        );
      }

      default:
        return finalizeFailure(input.missionId, ledgerPathResolved, input.profileId, sessionId, transcript, budget, "unknown agent kind");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "subagent session failed";
    return finalizeFailure(input.missionId, ledgerPathResolved, input.profileId, sessionId, transcript, budget, msg);
  }
}
