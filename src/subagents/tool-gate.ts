import type { SubagentProfileResolved } from "./schema";

export type ToolGateDecision =
  | { ok: true }
  | { ok: false; reason: string; code: "forbidden" | "not_allowed" | "budget" };

export function classifyToolAgainstProfile(toolName: string, profile: SubagentProfileResolved): ToolGateDecision {
  if (profile.forbiddenTools.includes(toolName)) {
    return { ok: false, reason: `${toolName} is forbidden for this subagent profile.`, code: "forbidden" };
  }

  if (profile.allowedTools.length > 0 && !profile.allowedTools.includes(toolName)) {
    return { ok: false, reason: `${toolName} is not in the profile allow-list.`, code: "not_allowed" };
  }

  return { ok: true };
}
