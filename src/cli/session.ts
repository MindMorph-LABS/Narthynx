export type CockpitMode = "plan" | "ask";

export interface InteractiveSessionState {
  cwd: string;
  currentMissionId?: string;
  cockpitMode: CockpitMode;
  exitCode: number;
  /** Default companion transcript session (`default` unless overridden). */
  companionSessionId: string;
  /** When true, free-text lines use companion chat instead of mission natural-language planner. */
  companionSurfaceActive: boolean;
}

export function createInteractiveSessionState(cwd: string): InteractiveSessionState {
  return {
    cwd,
    currentMissionId: undefined,
    cockpitMode: "ask",
    exitCode: 0,
    companionSessionId: "default",
    companionSurfaceActive: false
  };
}

export function isCockpitMode(value: string): value is CockpitMode {
  return value === "plan" || value === "ask";
}