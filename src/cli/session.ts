export type CockpitMode = "plan" | "ask";

export interface InteractiveSessionState {
  cwd: string;
  currentMissionId?: string;
  cockpitMode: CockpitMode;
  exitCode: number;
}

export function createInteractiveSessionState(cwd: string): InteractiveSessionState {
  return {
    cwd,
    currentMissionId: undefined,
    cockpitMode: "ask",
    exitCode: 0
  };
}

export function isCockpitMode(value: string): value is CockpitMode {
  return value === "plan" || value === "ask";
}