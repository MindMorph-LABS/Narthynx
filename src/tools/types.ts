import type { z } from "zod";

import type { RiskLevel } from "../missions/schema";

export type ToolSideEffect =
  | "none"
  | "local_read"
  | "local_write"
  | "shell"
  | "network"
  | "external_comm"
  | "credential"
  | "vault";

export interface ToolContext {
  cwd: string;
  missionId: string;
}

export interface ToolAction<Input, Output> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  riskLevel: RiskLevel;
  sideEffect: ToolSideEffect;
  requiresApproval: boolean;
  reversible: boolean;
  run(input: Input, context: ToolContext): Promise<Output>;
}

export interface ToolRunRequest {
  missionId: string;
  toolName: string;
  input: unknown;
}

export type ToolRunResult =
  | {
      ok: true;
      toolName: string;
      output: unknown;
      checkpointId?: string;
    }
  | {
      ok: false;
      toolName: string;
      message: string;
      blocked: boolean;
      approvalId?: string;
    };

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_tool" | "invalid_input" | "invalid_output" | "blocked" | "runtime_failed"
  ) {
    super(message);
  }
}
