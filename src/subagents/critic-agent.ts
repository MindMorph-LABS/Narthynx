import type { Mission } from "../missions/schema";
import { planGraphSchema, type PlanGraph } from "../missions/graph";

import type { ModelRouter } from "../agent/model-router";
import type { SubagentBudget } from "./budget";
import { criticResultSchema, type CriticResult, type SafetyResult, type VerifierResult } from "./schema";
import { verifyMissionDeterministic } from "./verifier-agent";
import { runSafetyReview } from "./safety-agent";

export function assembleCriticResult(
  verifier: VerifierResult,
  safety: SafetyResult | undefined,
  options: { safetySkipped: boolean; narrativeSuffix?: string }
): CriticResult {
  const compositeOk =
    verifier.ok &&
    (options.safetySkipped || !safety ? true : !safety.blocked || safety.severity === "low");

  const narrative = [
    verifier.summary,
    options.safetySkipped
      ? "(no hypothetical tool)."
      : safety
        ? `Safety:${safety.severity} blocked=${String(safety.blocked)}.`
        : "",
    options.narrativeSuffix ?? ""
  ]
    .join(" ")
    .trim();

  const assembled = criticResultSchema.safeParse({
    ok: compositeOk,
    verifier,
    safetySkipped: options.safetySkipped,
    ...(safety ? { safety } : {}),
    narrative
  });

  return assembled.success
    ? assembled.data
    : {
        ok: false,
        verifier,
        safetySkipped: options.safetySkipped,
        narrative: "critique assembler failed validation"
      };
}

export async function runCriticSession(input: {
  missionsDir: string;
  missionId: string;
  mission: Mission;
  graph: PlanGraph | unknown | null;
  router: ModelRouter;
  budget: SubagentBudget;
  criticToolHypothesis?: { toolName: string; toolInput: unknown };
}): Promise<CriticResult> {
  let graph: PlanGraph | null = null;
  const parsedGraph = input.graph ? planGraphSchema.safeParse(input.graph) : undefined;
  if (parsedGraph?.success) {
    graph = parsedGraph.data;
  }

  const verifier = await verifyMissionDeterministic({
    missionsDir: input.missionsDir,
    missionId: input.missionId,
    mission: input.mission,
    graph
  });

  let safetySkipped = true;
  let safety: SafetyResult | undefined;
  if (input.criticToolHypothesis?.toolName && input.budget.canUseModel()) {
    safetySkipped = false;
    safety = await runSafetyReview({
      missionId: input.missionId,
      router: input.router,
      budget: input.budget,
      proposedTool: input.criticToolHypothesis.toolName,
      proposedInput: input.criticToolHypothesis.toolInput
    });
  }

  return assembleCriticResult(verifier, safety, { safetySkipped });
}
