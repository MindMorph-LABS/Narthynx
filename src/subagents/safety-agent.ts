import type { ModelRouter } from "../agent/model-router";
import { safetyResultSchema, type SafetyResult } from "./schema";
import type { SubagentBudget } from "./budget";

export function heuristicSafety(toolName: string): SafetyResult {
  if (toolName === "shell.run") {
    return {
      blocked: true,
      severity: "high",
      reasons: ["shell.run is treated as inherently high-risk."],
      heuristicNote: "heuristic_gate"
    };
  }

  if (toolName === "filesystem.write" || toolName.startsWith("mcp.") || toolName.startsWith("github.")) {
    return {
      blocked: false,
      severity: "high",
      reasons: [`${toolName} requires explicit approvals and checkpoints in Narthynx.`],
      heuristicNote: "heuristic_gate"
    };
  }

  return {
    blocked: false,
    severity: "low",
    reasons: [`${toolName} passed coarse local heuristics (still subject to runner policy).`],
    heuristicNote: "heuristic_gate"
  };
}

export async function runSafetyReview(input: {
  missionId: string;
  router: ModelRouter;
  budget: SubagentBudget;
  proposedTool: string;
  proposedInput: unknown;
}): Promise<SafetyResult> {
  const base = heuristicSafety(input.proposedTool);

  if (!input.budget.canUseModel()) {
    return base;
  }

  if (!input.budget.consumeModelCall()) {
    return base;
  }

  try {
    const resp = await input.router.call({
      missionId: input.missionId,
      task: "subagent_safety",
      purpose: "frozen tool proposal safety review",
      sensitiveContextIncluded: false,
      input: {
        proposedTool: input.proposedTool,
        proposedInput: input.proposedInput,
        heuristic: base
      }
    });

    const parsedJson = extractJson(resp.content);
    const lm = parsedJson ? safetyResultSchema.safeParse(parsedJson) : undefined;
    if (lm?.success) {
      return mergeSafety(base, lm.data);
    }
  } catch {
    /* fall back below */
  }

  return base;
}

function mergeSafety(heuristic: SafetyResult, lm: SafetyResult): SafetyResult {
  const severityOrder = { low: 0, medium: 1, high: 2 };
  const sev =
    severityOrder[lm.severity] >= severityOrder[heuristic.severity] ? lm.severity : heuristic.severity;

  const blocked = Boolean(lm.blocked || heuristic.blocked || sev === "high");

  return {
    blocked,
    severity: sev,
    reasons: [...new Set([...heuristic.reasons, ...lm.reasons])].slice(0, 12),
    heuristicNote: "model_assisted_review"
  };
}

function extractJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }
}
