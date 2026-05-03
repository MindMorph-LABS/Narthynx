import { access, readFile } from "node:fs/promises";

import type { Mission } from "../missions/schema";
import { reportArtifactPath } from "../missions/artifacts";
import { planGraphSchema, type PlanGraph } from "../missions/graph";
import { missionDirectory } from "../missions/store";
import { verifierResultSchema, type VerifierResult } from "./schema";

async function pathExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function verifyMissionDeterministic(input: {
  missionsDir: string;
  missionId: string;
  mission: Mission;
  graph: PlanGraph | null;
}): Promise<VerifierResult> {
  const checks: VerifierResult["checks"] = [];

  const reportPath = reportArtifactPath(missionDirectory(input.missionsDir, input.missionId));
  const reportOk = await pathExists(reportPath);
  checks.push({
    id: "report_artifact_present",
    ok: reportOk,
    detail: reportOk ? reportPath : "Expected artifacts/report.md to exist"
  });

  const graphParsed = input.graph ? planGraphSchema.safeParse(input.graph) : { success: false as const };

  checks.push({
    id: "plan_graph_valid",
    ok: graphParsed.success,
    detail: graphParsed.success ? `nodes=${graphParsed.data.nodes.length}` : "persisted graph is missing or fails PlanGraph validation"
  });

  const graphData = graphParsed.success ? graphParsed.data : undefined;
  const incompleteNodes =
    graphData?.nodes.filter((n) => n.status !== "completed" && n.status !== "failed").length ?? 0;

  checks.push({
    id: "no_pending_skeleton_nodes_when_completed",
    ok: !(input.mission.state === "completed" && incompleteNodes > 0),
    detail:
      input.mission.state === "completed"
        ? `${incompleteNodes} node(s) not in terminal status`
        : `mission.state=${input.mission.state} (skipped strict completion coupling)`
  });

  if (reportOk) {
    try {
      const text = await readFile(reportPath, "utf8");
      checks.push({
        id: "report_non_empty",
        ok: text.trim().length > 200,
        detail: `${text.trim().length} characters`
      });
    } catch {
      checks.push({
        id: "report_readable",
        ok: false,
        detail: "report.md unreadable after existence check"
      });
    }
  }

  const ok = checks.every((c) => c.ok);
  const severity = checks.some((c) => !c.ok && (c.id === "report_artifact_present" || c.id === "plan_graph_valid"))
    ? "error"
    : ok
      ? "info"
      : "warn";

  const result = verifierResultSchema.safeParse({
    ok,
    severity,
    checks,
    summary: ok ? "Verifier checks passed." : "Verifier found mission quality issues."
  });
  return result.success ? result.data : { ok: false, severity: "error", checks: [], summary: "Verifier failed internal validation." };
}
