import type { WorkspacePolicy } from "../config/load";

import type { DaemonJobPayload } from "./schema";

export function classifyJobAgainstDaemonPolicy(
  policy: WorkspacePolicy,
  job: DaemonJobPayload
): { ok: true } | { ok: false; reason: string } {
  const mode = policy.daemon_background_actions;
  switch (job.kind) {
    case "notify":
    case "emit_event":
    case "scheduled_tick":
    case "trigger_followup":
      return { ok: true };
    case "create_mission":
      if (mode === "observe_only") {
        return { ok: false, reason: "observe_only daemon policy blocks create_mission jobs" };
      }
      return { ok: true };
    case "execute_mission":
      if (mode !== "allow_low_risk_automation") {
        return { ok: false, reason: "execute_mission requires daemon_background_actions: allow_low_risk_automation" };
      }
      return { ok: true };
    default:
      return { ok: false, reason: "Unsupported daemon job kind" };
  }
}
