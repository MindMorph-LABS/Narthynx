import path from "node:path";
import { z } from "zod";

import { doctorWorkspace, resolveWorkspacePaths } from "../../config/workspace";
import type { LedgerEvent } from "../../missions/ledger";
import { buildMissionReplay } from "../../missions/replay";
import { createApprovalStore } from "../../missions/approvals";
import { createMissionStore, missionDirectory } from "../../missions/store";
import { createReportService } from "../../missions/reports";
import { reportArtifactPath } from "../../missions/artifacts";
import { createToolRegistry } from "../../tools/registry";
import { createToolRunner } from "../../tools/runner";
import { planGraphToFlowDto } from "../graph-dto";
import { Hono } from "hono";

const missionIdParam = z.string().regex(/^m_[a-z0-9_-]+$/);
const approvalIdParam = z.string().regex(/^a_[a-z0-9_-]+$/);

function jsonError(message: string, code: string) {
  return { error: message, code } as const;
}

export function createCockpitApiRouter(cwd: string): Hono {
  const app = new Hono();
  const paths = resolveWorkspacePaths(cwd);
  const missionStore = createMissionStore(cwd);
  const approvalStore = createApprovalStore(cwd);
  const reportService = createReportService(cwd);
  const toolRegistry = createToolRegistry();
  const toolRunner = createToolRunner({ cwd, registry: toolRegistry });

  app.get("/health", async (c) => {
    const doctor = await doctorWorkspace(cwd);
    return c.json({
      ok: doctor.ok,
      checks: doctor.checks
    });
  });

  app.get("/missions", async (c) => {
    try {
      const missions = await missionStore.listMissions();
      return c.json({
        missions: missions.map((m) => ({
          id: m.id,
          title: m.title,
          state: m.state,
          riskLevel: m.riskProfile.level,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt
        }))
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to list missions";
      return c.json(jsonError(message, "mission_list_failed"), 500);
    }
  });

  app.get("/missions/:missionId", async (c) => {
    const parsed = missionIdParam.safeParse(c.req.param("missionId"));
    if (!parsed.success) {
      return c.json(jsonError("Invalid mission id", "invalid_mission_id"), 400);
    }

    try {
      const mission = await missionStore.readMission(parsed.data);
      return c.json({
        mission: {
          id: mission.id,
          title: mission.title,
          goal: mission.goal,
          state: mission.state,
          successCriteria: mission.successCriteria,
          riskProfile: mission.riskProfile,
          createdAt: mission.createdAt,
          updatedAt: mission.updatedAt,
          artifacts: mission.artifacts
        }
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Mission not found";
      return c.json(jsonError(message, "mission_not_found"), 404);
    }
  });

  app.get("/missions/:missionId/graph", async (c) => {
    const parsed = missionIdParam.safeParse(c.req.param("missionId"));
    if (!parsed.success) {
      return c.json(jsonError("Invalid mission id", "invalid_mission_id"), 400);
    }

    try {
      const graph = await missionStore.readMissionPlanGraph(parsed.data);
      return c.json({ graph: planGraphToFlowDto(graph), raw: graph });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Graph not found";
      return c.json(jsonError(message, "graph_not_found"), 404);
    }
  });

  app.get("/missions/:missionId/ledger", async (c) => {
    const parsed = missionIdParam.safeParse(c.req.param("missionId"));
    if (!parsed.success) {
      return c.json(jsonError("Invalid mission id", "invalid_mission_id"), 400);
    }

    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Math.min(5000, Math.max(1, Number(limitRaw) || 100)) : 500;

    try {
      await missionStore.readMission(parsed.data);
      const events = await missionStore.readMissionLedger(parsed.data, { allowMissing: true });
      const slice = events.slice(-limit);
      return c.json({
        missionId: parsed.data,
        total: events.length,
        events: slice.map((ev: LedgerEvent) => ({
          id: ev.id,
          type: ev.type,
          timestamp: ev.timestamp,
          summary: ev.summary,
          details: ev.details
        }))
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Ledger read failed";
      return c.json(jsonError(message, "ledger_failed"), 500);
    }
  });

  app.get("/missions/:missionId/replay", async (c) => {
    const parsed = missionIdParam.safeParse(c.req.param("missionId"));
    if (!parsed.success) {
      return c.json(jsonError("Invalid mission id", "invalid_mission_id"), 400);
    }

    try {
      const mission = await missionStore.readMission(parsed.data);
      const ledger = await missionStore.readMissionLedger(parsed.data);
      const replay = buildMissionReplay({
        missionId: mission.id,
        missionTitle: mission.title,
        ledger
      });
      return c.json({ replay });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Replay failed";
      return c.json(jsonError(message, "replay_failed"), 500);
    }
  });

  app.get("/missions/:missionId/report", async (c) => {
    const parsed = missionIdParam.safeParse(c.req.param("missionId"));
    if (!parsed.success) {
      return c.json(jsonError("Invalid mission id", "invalid_mission_id"), 400);
    }

    try {
      const markdown = await reportService.readReport(parsed.data);
      return c.json({ markdown, format: "markdown" as const });
    } catch {
      return c.json(jsonError("Report not found or not readable", "report_not_found"), 404);
    }
  });

  app.get("/missions/:missionId/report/path", async (c) => {
    const parsed = missionIdParam.safeParse(c.req.param("missionId"));
    if (!parsed.success) {
      return c.json(jsonError("Invalid mission id", "invalid_mission_id"), 400);
    }

    try {
      await missionStore.readMission(parsed.data);
    } catch {
      return c.json(jsonError("Mission not found", "mission_not_found"), 404);
    }

    const abs = reportArtifactPath(missionDirectory(paths.missionsDir, parsed.data));
    let relative = path.relative(paths.rootDir, abs);
    if (relative.startsWith("..")) {
      relative = abs;
    }
    return c.json({ path: abs, workspaceRelative: relative });
  });

  app.get("/approvals/pending", async (c) => {
    try {
      const approvals = await approvalStore.listPendingApprovals();
      return c.json({
        approvals: approvals.map((a) => ({
          id: a.id,
          missionId: a.missionId,
          toolName: a.toolName,
          riskLevel: a.riskLevel,
          status: a.status,
          reason: a.reason,
          prompt: a.prompt,
          createdAt: a.createdAt
        }))
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "List failed";
      return c.json(jsonError(message, "approvals_failed"), 500);
    }
  });

  const decideBodySchema = z.object({
    decision: z.enum(["approved", "denied"]),
    reason: z.string().optional()
  });

  app.post("/approvals/:approvalId/decide", async (c) => {
    const parsedId = approvalIdParam.safeParse(c.req.param("approvalId"));
    if (!parsedId.success) {
      return c.json(jsonError("Invalid approval id", "invalid_approval_id"), 400);
    }

    let body: z.infer<typeof decideBodySchema>;
    try {
      body = decideBodySchema.parse(await c.req.json());
    } catch {
      return c.json(jsonError("Invalid JSON body", "invalid_body"), 400);
    }

    try {
      const approval = await approvalStore.decideApproval(parsedId.data, body.decision, body.reason);

      const response: {
        approval: typeof approval;
        executed?: unknown;
        executionMessage?: string;
        checkpointId?: string;
      } = { approval };

      if (approval.status === "approved") {
        const continuation = await toolRunner.runApprovedTool(approval.id);
        if (continuation.ok) {
          response.executed = continuation.output;
          response.checkpointId = continuation.checkpointId;
        } else {
          response.executionMessage = continuation.message;
        }
      }

      return c.json(response);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Decision failed";
      return c.json(jsonError(message, "decide_failed"), 400);
    }
  });

  return app;
}
