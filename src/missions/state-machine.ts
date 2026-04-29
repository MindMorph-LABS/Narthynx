import type { MissionState } from "./schema";

const ALLOWED_TRANSITIONS: Record<MissionState, MissionState[]> = {
  created: ["planning", "cancelled"],
  planning: ["running", "cancelled"],
  running: ["waiting_for_approval", "failed", "paused", "verifying", "cancelled"],
  waiting_for_approval: ["running", "paused", "cancelled"],
  paused: ["running", "cancelled"],
  verifying: ["completed", "failed", "running", "cancelled"],
  failed: ["recovering", "cancelled"],
  recovering: ["running", "failed", "cancelled"],
  completed: ["cancelled"],
  cancelled: []
};

export function canTransitionMissionState(from: MissionState, to: MissionState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertMissionStateTransition(from: MissionState, to: MissionState): void {
  if (!canTransitionMissionState(from, to)) {
    throw new Error(`Invalid mission state transition: ${from} -> ${to}`);
  }
}

export function allowedMissionStateTransitions(from: MissionState): MissionState[] {
  return [...ALLOWED_TRANSITIONS[from]];
}
