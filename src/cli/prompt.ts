import type { Mission } from "../missions/schema";
import type { InteractiveSessionState } from "./session";

export function buildPrompt(session: InteractiveSessionState, mission?: Mission): string {
  if (session.companionSurfaceActive) {
    return "narthynx cmp ❯ ";
  }

  const mid = session.currentMissionId;
  if (!mid) {
    return "narthynx ❯ ";
  }

  if (mission?.state === "waiting_for_approval") {
    return `narthynx ${mid} approval ❯ `;
  }

  return `narthynx ${mid} ❯ `;
}
