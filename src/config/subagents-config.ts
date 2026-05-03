import { readFile } from "node:fs/promises";

import YAML from "yaml";

import type { ValidationResult } from "./load";
import {
  subagentKindSchema,
  subagentProfileSchema,
  subagentsConfigSchema,
  type SubagentProfileResolved,
  type SubagentsConfig
} from "../subagents/schema";

const DEFAULT_PROFILES = {
  planner: {
    kind: "planner" as const,
    allowedTools: [] as string[],
    forbiddenTools: ["shell.run", "vault.read", "mcp.tools.call"],
    maxTurns: 2,
    maxToolCallsPerSession: 0,
    maxModelCallsPerSession: 2,
    riskBoundary: "medium" as const,
    requireExplicitApply: true
  },
  verifier: {
    kind: "verifier" as const,
    allowedTools: [] as string[],
    forbiddenTools: ["shell.run", "vault.read", "filesystem.write", "mcp.tools.call"],
    maxTurns: 1,
    maxToolCallsPerSession: 0,
    maxModelCallsPerSession: 1,
    riskBoundary: "low" as const,
    requireExplicitApply: false
  },
  safety: {
    kind: "safety" as const,
    allowedTools: [] as string[],
    forbiddenTools: ["shell.run", "vault.read", "filesystem.write", "mcp.tools.call", "filesystem.list"],
    maxTurns: 1,
    maxToolCallsPerSession: 0,
    maxModelCallsPerSession: 1,
    riskBoundary: "high" as const,
    requireExplicitApply: false
  },
  critic: {
    kind: "critic" as const,
    allowedTools: [] as string[],
    forbiddenTools: ["shell.run", "vault.read", "mcp.tools.call"],
    maxTurns: 1,
    maxToolCallsPerSession: 0,
    maxModelCallsPerSession: 2,
    riskBoundary: "medium" as const,
    requireExplicitApply: false
  }
};

export const DEFAULT_SUBAGENTS_CONFIG: SubagentsConfig = subagentsConfigSchema.parse({
  version: 1,
  enabled: true,
  profiles: DEFAULT_PROFILES
});

function mergeProfileDefaults(profileId: string, raw: unknown): SubagentProfileResolved {
  const preset = DEFAULT_PROFILES[profileId as keyof typeof DEFAULT_PROFILES];
  const base: SubagentProfileResolved = preset ?? {
    kind: "verifier",
    allowedTools: [],
    forbiddenTools: ["shell.run", "vault.read"],
    maxTurns: 1,
    maxToolCallsPerSession: 0,
    maxModelCallsPerSession: 1,
    riskBoundary: "medium",
    requireExplicitApply: false
  };

  if (raw === null || typeof raw !== "object") {
    return subagentProfileSchema.parse(base);
  }

  const obj = raw as Record<string, unknown>;
  const kindRaw = obj.kind;
  const kind =
    typeof kindRaw === "string" ? subagentKindSchema.safeParse(kindRaw).data ?? base.kind : base.kind;

  const kindDefaults =
    DEFAULT_PROFILES[kind as keyof typeof DEFAULT_PROFILES] ??
    DEFAULT_PROFILES.verifier;

  return subagentProfileSchema.parse({
    ...kindDefaults,
    ...base,
    ...obj,
    kind
  });
}

function buildConfigFromParsed(parsed: unknown): SubagentsConfig {
  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    return DEFAULT_SUBAGENTS_CONFIG;
  }

  const root = parsed as Record<string, unknown>;
  const enabled = typeof root.enabled === "boolean" ? root.enabled : true;
  const userProfiles =
    root.profiles !== null && typeof root.profiles === "object" ? (root.profiles as Record<string, unknown>) : {};

  const profileIds = new Set([...Object.keys(DEFAULT_PROFILES), ...Object.keys(userProfiles)]);
  const profiles: Record<string, SubagentProfileResolved> = {};

  for (const id of profileIds) {
    profiles[id] = mergeProfileDefaults(id, userProfiles[id]);
  }

  return subagentsConfigSchema.parse({
    version: 1,
    enabled,
    profiles
  });
}

export async function loadSubagentsConfig(filePath: string): Promise<ValidationResult<SubagentsConfig>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = YAML.parse(raw);
    const config = buildConfigFromParsed(parsed);
    return { ok: true, path: filePath, value: config };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {
        ok: true,
        path: filePath,
        value: DEFAULT_SUBAGENTS_CONFIG
      };
    }

    return {
      ok: false,
      path: filePath,
      message: error instanceof Error ? error.message : "Unknown subagents.yaml load failure"
    };
  }
}
