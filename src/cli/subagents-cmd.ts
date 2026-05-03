import type { Command } from "commander";

import { createModelRouter } from "../agent/model-router";
import { createApprovalStore } from "../missions/approvals";
import { resolveWorkspacePaths } from "../config/workspace";
import { loadSubagentsConfig } from "../config/subagents-config";
import { runSubagentSession } from "../subagents/orchestrator";
import type { SubagentKind } from "../subagents/schema";

interface CliIo {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
}

function summarizeProfile(kind: SubagentKind, profile: Record<string, unknown>): string {
  return JSON.stringify(
    {
      kind,
      caps: {
        maxTurns: profile.maxTurns,
        maxToolCallsPerSession: profile.maxToolCallsPerSession,
        maxModelCallsPerSession: profile.maxModelCallsPerSession,
        riskBoundary: profile.riskBoundary
      },
      allowForbidCounts: {
        allowedTools: Array.isArray(profile.allowedTools) ? profile.allowedTools.length : 0,
        forbiddenTools: Array.isArray(profile.forbiddenTools) ? profile.forbiddenTools.length : 0
      }
    },
    null,
    2
  );
}

export function attachSubagentsCommands(program: Command, cwd: string, io: CliIo): void {
  const sub = program.command("subagents").description("Bounded expert subagents (Frontier F20): verifier, planner, safety, critic.");

  sub
    .command("list")
    .description("List configured profiles and budget caps (.narthynx/subagents.yaml + defaults).")
    .action(async () => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const cfg = await loadSubagentsConfig(paths.subagentsFile);
        if (!cfg.ok) {
          io.writeErr(`subagents.yaml invalid: ${cfg.message}\n`);
          process.exitCode = 1;
          return;
        }
        io.writeOut(`enabled=${String(cfg.value.enabled)}  path=${cfg.path}\n`);
        for (const [id, profile] of Object.entries(cfg.value.profiles)) {
          io.writeOut(`\nprofile: ${id}\n${summarizeProfile(profile.kind, profile as Record<string, unknown>)}\n`);
        }
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "subagents list failed"}\n`);
        process.exitCode = 1;
      }
    });

  sub
    .command("inspect")
    .description("Print full normalized profile JSON (merged with defaults).")
    .argument("<name>", "Profile id from subagents.yaml (e.g. planner, verifier)")
    .action(async (name: string) => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const cfg = await loadSubagentsConfig(paths.subagentsFile);
        if (!cfg.ok) {
          io.writeErr(`subagents.yaml invalid: ${cfg.message}\n`);
          process.exitCode = 1;
          return;
        }
        const profile = cfg.value.profiles[name.trim()];
        if (!profile) {
          io.writeErr(`Unknown profile "${name}".\n`);
          process.exitCode = 1;
          return;
        }
        io.writeOut(JSON.stringify(profile, null, 2) + "\n");
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "subagents inspect failed"}\n`);
        process.exitCode = 1;
      }
    });

  sub
    .command("run")
    .description("Run a bounded subagent session against a mission (planner stays dry-run unless --apply --yes).")
    .argument("<name>", "Profile id (planner | verifier | safety | critic)")
    .argument("<mission-id>", "Mission id")
    .option("--apply", "Planner only: persist model draft to mission graph.json", false)
    .option("--yes", "Planner only: affirm explicit apply when profile.requireExplicitApply is true", false)
    .option("--tool <name>", "Safety/critic hypothetical tool name")
    .option("--input-json <json>", "JSON-encoded tool input for --tool")
    .action(
      async (
        name: string,
        missionId: string,
        opts: {
          apply?: boolean;
          yes?: boolean;
          tool?: string;
          inputJson?: string;
        }
      ) => {
        try {
          const hypotheticalTool =
            opts.tool && opts.tool.trim().length > 0
              ? {
                  toolName: opts.tool.trim(),
                  toolInput: parseJsonFlexible(opts.inputJson ?? "{}", `--input-json for tool ${opts.tool}`)
                }
              : undefined;

          const router = createModelRouter({ cwd, approvalStore });

          const result = await runSubagentSession({
            cwd,
            missionId: missionId.trim(),
            profileId: name.trim(),
            router,
            approvalStoreProvided: approvalStore,
            hypotheticalTool,
            applyPlanner: Boolean(opts.apply),
            plannerConfirmYes: Boolean(opts.yes)
          });

          io.writeOut(
            JSON.stringify(
              {
                status: result.status,
                profileId: result.profileId,
                sessionId: result.sessionId,
                error: result.error,
                budgetUsed: result.budgetUsed,
                payload: result.payload,
                transcriptPreview: result.transcriptPreview
              },
              null,
              2
            ) + "\n"
          );

          if (result.status === "failed") {
            process.exitCode = 1;
          }
        } catch (error) {
          io.writeErr(`${error instanceof Error ? error.message : "subagents run failed"}\n`);
          process.exitCode = 1;
        }
      }
    );
}

function parseJsonFlexible(raw: string, label: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`Invalid JSON for ${label}.`);
  }
}
