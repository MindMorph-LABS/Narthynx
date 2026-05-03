import type { DoctorResult } from "../../config/workspace";
import type { ApprovalRequest } from "../../missions/approvals";
import type { PlanGraph } from "../../missions/graph";
import type { LedgerEvent } from "../../missions/ledger";
import type { Mission } from "../../missions/schema";
import type { MissionTemplate } from "../../missions/templates";
import type { WorkspacePolicy } from "../../config/load";
import type { ToolAction } from "../../tools/types";
import { buildPrompt } from "../prompt";
import type { InteractiveSessionState } from "../session";
import type { InteractiveIo, IntroParams, Renderer, StatusParams } from "../renderer";

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function formatApprovalTarget(approval: ApprovalRequest): string {
  const input = approval.toolInput;
  if (typeof input === "object" && input !== null) {
    if ("path" in input && typeof (input as { path?: unknown }).path === "string") {
      return (input as { path: string }).path;
    }
    if ("command" in input && typeof (input as { command?: unknown }).command === "string") {
      const o = input as { command: string; args?: string[] };
      return o.args?.length ? o.command + " " + o.args.join(" ") : o.command;
    }
  }
  const firstLine = approval.prompt.split(/\r?\n/)[0];
  return firstLine ?? approval.toolName;
}

type TextRow = string[];

export function createReadlineRenderer(io: InteractiveIo): Renderer {
  const writePanel = (title: string, body: string): void => {
    io.writeOut(title + "\n" + body + "\n");
  };

  return {
    intro(params: IntroParams): void {
      io.writeOut(
        [
          "NARTHYNX",
          "Local-first Mission Agent OS",
          "Persistent missions. Approval-gated actions. Replayable execution.",
          "",
          "Workspace: " + params.workspace,
          "Policy: " + params.policyLabel,
          "Mode: " + params.cockpitMode,
          "Model: " + params.modelLabel,
          "Active mission: " + params.activeMissionId,
          "",
          "Type a goal, or use /help."
        ].join("\n")
      );
    },

    status(params: StatusParams): void {
      const cockpit = titleCase(params.cockpitMode);
      const missionId = params.mission?.id ?? "none";
      const state = params.mission?.state ?? "none";
      const policy = params.policyMode ?? "unknown";
      io.writeOut(
        "Narthynx  mode: " +
          cockpit +
          "  mission: " +
          missionId +
          "  state: " +
          state +
          "  policy: " +
          policy +
          "  model: " +
          params.modelLabel +
          "\n"
      );
    },

    formatPrompt(session: InteractiveSessionState, mission?: Mission): string {
      return buildPrompt(session, mission);
    },

    info(message: string): void {
      io.writeOut(message + "\n");
    },

    warn(message: string): void {
      io.writeErr(message + "\n");
    },

    renderError(text: string): void {
      io.writeErr(text + "\n");
    },

    table(rows: TextRow[]): void {
      for (const row of rows) {
        io.writeOut(row.join("  ") + "\n");
      }
    },

    panel(title: string, body: string): void {
      writePanel(title, body);
    },

    missionList(missions: Mission[]): void {
      if (missions.length === 0) {
        io.writeOut("No missions found.\n");
        return;
      }
      io.writeOut(
        ["Missions", ...missions.map((m) => m.id + "  " + m.state + "  " + m.createdAt + "  " + m.title)].join("\n") + "\n"
      );
    },

    plan(missionId: string, lines: string[], modelSuffix = ""): void {
      io.writeOut(["Plan for " + missionId + modelSuffix, ...lines].join("\n") + "\n");
    },

    graph(graph: PlanGraph): void {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      const incoming = new Set(graph.edges.map((e) => e.to));
      const roots = graph.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
      const startIds = roots.length > 0 ? roots : ([graph.nodes[0]?.id].filter(Boolean) as string[]);

      io.writeOut(
        "Graph for " + graph.missionId + " (" + String(graph.nodes.length) + " nodes, " + String(graph.edges.length) + " edges)\n"
      );

      const visited = new Set<string>();
      const walk = (id: string, depth: number): void => {
        if (visited.has(id)) {
          return;
        }
        visited.add(id);
        const node = byId.get(id);
        if (!node) {
          return;
        }
        const pad = "  ".repeat(depth);
        io.writeOut(
          pad + "- [" + node.type + "] " + node.title + " (" + node.status + ")\n"
        );
        const outs = graph.edges.filter((e) => e.from === id).map((e) => e.to);
        for (const to of outs) {
          walk(to, depth + 1);
        }
      };

      for (const id of startIds) {
        walk(id, 0);
      }
      for (const node of graph.nodes) {
        if (!visited.has(node.id)) {
          walk(node.id, 0);
        }
      }
    },

    timeline(missionId: string, events: LedgerEvent[]): void {
      if (events.length === 0) {
        io.writeOut("No ledger events found for mission " + missionId + ".\n");
        return;
      }
      io.writeOut(
        [
          "Timeline for " + missionId,
          ...events.map((e, i) => String(i + 1) + ". " + e.timestamp + "  " + e.type + "  " + e.summary)
        ].join("\n") + "\n"
      );
    },

    approvalPrompt(approval: ApprovalRequest, missionTitle?: string): void {
      const risk = approval.riskLevel + " — " + approval.reason;
      const target = formatApprovalTarget(approval);
      const missionLine = missionTitle ? missionTitle + " (" + approval.missionId + ")" : approval.missionId;
      writePanel(
        "Approval required",
        [
          "Action: " + approval.toolName,
          "Mission: " + missionLine,
          "Risk: " + risk,
          "Target: " + target,
          "",
          "[a] approve once   [e] edit   [d] deny   [p] pause",
          "Esc or most other keys: cancel this key prompt (use /approve …).",
          "",
          "Or: /approve " + approval.id + "   /approve " + approval.id + " --deny"
        ].join("\n")
      );
    },

    help(): void {
      io.writeOut(
        [
          "Narthynx slash commands (full reference: docs/cli-ux.md)",
          "",
          "Missions & planning",
          "/mission <goal|mission-id>    Create or switch mission",
          "/mission --template <name>     Create from a built-in template",
          "/mission                      Show current mission",
          "/missions                     List missions",
          "/templates                    List templates",
          "/plan [mission-id] [--model]  Show or regenerate plan",
          "/graph [mission-id]           Show plan graph (nodes and edges)",
          "",
          "Execution & context",
          "/run [mission-id]             Mission executor (approval-gated)",
          "/pause /resume [mission-id]   Pause or resume",
          "/timeline [mission-id]        Action ledger",
          "/context …                  Context diet (see /help lines below)",
          "/tool … --input <json>        Typed tools (policy + approvals)",
          "",
          "Artifacts & reports",
          "/report /proof /replay [id]   Report, proof card, replay story",
          "/cost [mission-id]            Token & cost summary",
          "/rewind <checkpoint-id> [id] Restore checkpoint",
          "",
          "Safety & workspace",
          "/approve [id] [--deny]        Approvals queue",
          "/policy                       Inspect policy (read-only)",
          "/tools                        List typed tools",
          "/doctor                       Health checks",
          "/mode [plan|ask]              Cockpit mode (display / NL framing)",
          "/daemon status                Daemon snapshot (.narthynx/daemon — see docs/daemon.md)",
          "/events [--since <ISO>]      Recent daemon event log",
          "/queue                        Daemon job queue replay view",
          "/clear                        Clear terminal (console.clear)",
          "",
          "Session",
          "/help                         This help",
          "/exit                         Leave interactive shell",
          "",
          "Context flags",
          "/context [mission-id]",
          "/context --note <text>",
          "/context --file <path> --reason <text>",
          "/context [mission-id] --pack",
          "",
          "Shortcuts",
          "! <command>                   shell.run (approval-gated)",
          "@ <path>                      Attach file to mission context",
          "# <note>                      Note (mission or workspace-notes.md)"
        ].join("\n") + "\n"
      );
    },

    doctor(result: DoctorResult): void {
      io.writeOut("Narthynx doctor\n");
      for (const check of result.checks) {
        io.writeOut((check.ok ? "ok" : "fail") + "  " + check.name + ": " + check.message + "\n");
      }
      io.writeOut((result.ok ? "Workspace is healthy." : "Workspace is not healthy. Run: narthynx init") + "\n");
    },

    missionSummary(mission: Mission): void {
      io.writeOut(
        [
          "Mission " + mission.id,
          "title: " + mission.title,
          "goal: " + mission.goal,
          "state: " + mission.state,
          "risk: " + mission.riskProfile.level + " (" + mission.riskProfile.reasons.join("; ") + ")"
        ].join("\n") + "\n"
      );
    },

    templates(templates: MissionTemplate[]): void {
      io.writeOut(
        [
          "Mission templates",
          ...templates.map((t) => t.name + "  risk=" + t.riskProfile.level + "  " + t.description)
        ].join("\n") + "\n"
      );
    },

    policy(policy: WorkspacePolicy, policyPath: string): void {
      io.writeOut(
        [
          "Policy",
          "path: " + policyPath,
          "mode: " + policy.mode,
          "allow_network: " + String(policy.allow_network),
          "shell: " + policy.shell,
          "filesystem.read: " + policy.filesystem.read.join(", "),
          "filesystem.write: " + policy.filesystem.write.join(", "),
          "filesystem.deny: " + policy.filesystem.deny.join(", "),
          "external_communication: " + policy.external_communication,
          "credentials: " + policy.credentials,
          "cloud_model_sensitive_context: " + policy.cloud_model_sensitive_context,
          "Policy editing is not implemented yet."
        ].join("\n") + "\n"
      );
    },

    tools(tools: ToolAction<unknown, unknown>[]): void {
      io.writeOut(
        [
          "Tools",
          ...tools.map(
            (tool) =>
              tool.name +
              "  risk=" +
              tool.riskLevel +
              "  sideEffect=" +
              tool.sideEffect +
              "  approval=" +
              (tool.requiresApproval ? "yes" : "no")
          )
        ].join("\n") + "\n"
      );
    },

    approvals(list: ApprovalRequest[]): void {
      if (list.length === 0) {
        io.writeOut("No pending approvals.\n");
        return;
      }
      io.writeOut(
        [
          "Pending approvals",
          ...list.flatMap((approval) => [
            approval.id +
              "  mission=" +
              approval.missionId +
              "  tool=" +
              approval.toolName +
              "  risk=" +
              approval.riskLevel +
              "  status=" +
              approval.status,
            "  " + approval.prompt.split(/\r?\n/)[0]
          ])
        ].join("\n") + "\n"
      );
    },

    rawBlock(text: string): void {
      const trimmed = text.endsWith("\n") ? text : text + "\n";
      io.writeOut(trimmed);
    },

    clear(): void {
      console.clear();
    }
  };
}
