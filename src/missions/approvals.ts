import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";
import { z } from "zod";

import { resolveWorkspacePaths } from "../config/workspace";
import { createApprovalId } from "../utils/ids";
import type { LedgerActorRef } from "./ledger";
import { appendLedgerEvent, ledgerFilePath } from "./ledger";
import { riskLevelSchema } from "./schema";
import { missionDirectory, missionFilePath } from "./store";

export const APPROVALS_FILE_NAME = "approvals.json";

export const approvalStatusSchema = z.enum(["pending", "approved", "denied"]);

export const approvalRequestSchema = z.object({
  id: z.string().regex(/^a_[a-z0-9_-]+$/),
  missionId: z.string().regex(/^m_[a-z0-9_-]+$/),
  toolName: z.string().min(1),
  toolInput: z.unknown(),
  riskLevel: riskLevelSchema,
  sideEffect: z.enum(["none", "local_read", "local_write", "shell", "network", "external_comm", "credential"]),
  status: approvalStatusSchema,
  reason: z.string().min(1),
  prompt: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
  decisionReason: z.string().min(1).optional(),
  executedAt: z.string().datetime().optional(),
  checkpointId: z.string().regex(/^c_[a-z0-9_-]+$/).optional()
});

export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export interface CreateApprovalInput {
  missionId: string;
  toolName: string;
  toolInput: unknown;
  riskLevel: ApprovalRequest["riskLevel"];
  sideEffect: ApprovalRequest["sideEffect"];
  reason: string;
  target?: string;
}

export interface ApprovalStore {
  createApproval(input: CreateApprovalInput): Promise<ApprovalRequest>;
  getApproval(id: string): Promise<ApprovalRequest>;
  listMissionApprovals(missionId: string, options?: { allowMissing?: boolean }): Promise<ApprovalRequest[]>;
  listPendingApprovals(): Promise<ApprovalRequest[]>;
  decideApproval(
    id: string,
    decision: "approved" | "denied",
    reason?: string,
    options?: { actor?: LedgerActorRef }
  ): Promise<ApprovalRequest>;
  markApprovalExecuted(id: string, checkpointId?: string): Promise<ApprovalRequest>;
}

export function approvalsFilePath(missionDir: string): string {
  return path.join(missionDir, APPROVALS_FILE_NAME);
}

export function createApprovalStore(cwd = process.cwd()): ApprovalStore {
  const paths = resolveWorkspacePaths(cwd);

  return {
    async createApproval(input) {
      const now = new Date().toISOString();
      const approval = approvalRequestSchema.parse({
        id: createApprovalId(),
        missionId: input.missionId,
        toolName: input.toolName,
        toolInput: input.toolInput,
        riskLevel: input.riskLevel,
        sideEffect: input.sideEffect,
        status: "pending",
        reason: input.reason,
        prompt: formatApprovalPrompt(input),
        createdAt: now,
        updatedAt: now
      });
      const existing = await this.listMissionApprovals(input.missionId, { allowMissing: true });
      const approvals = [...existing, approval];

      await writeApprovals(paths.missionsDir, input.missionId, approvals);
      await mirrorMissionApprovals(paths.missionsDir, input.missionId, approvals);

      return approval;
    },

    async listMissionApprovals(missionId, options = {}) {
      return readApprovals(approvalsFilePath(missionDirectory(paths.missionsDir, missionId)), options);
    },

    async getApproval(id) {
      const found = await findApprovalById(paths.missionsDir, id);
      if (!found) {
        throw new Error(`Approval not found: ${id}`);
      }

      return found.approval;
    },

    async listPendingApprovals() {
      const entries = await readdir(paths.missionsDir, { withFileTypes: true });
      const approvals = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => this.listMissionApprovals(entry.name, { allowMissing: true }))
      );

      return approvals
        .flat()
        .filter((approval) => approval.status === "pending")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },

    async decideApproval(id, decision, reason, options = {}) {
      const found = await findApprovalById(paths.missionsDir, id);
      if (!found) {
        throw new Error(`Approval not found: ${id}`);
      }

      const { missionId, approvals, approval } = found;
      if (approval.status !== "pending") {
        if (approval.status === decision) {
          return approval;
        }

        throw new Error(`Approval ${id} is already ${approval.status}.`);
      }

      const now = new Date().toISOString();
      const updated = approvalRequestSchema.parse({
        ...approval,
        status: decision,
        updatedAt: now,
        decidedAt: now,
        decisionReason: reason
      });
      const nextApprovals = approvals.map((candidate) => (candidate.id === id ? updated : candidate));

      await writeApprovals(paths.missionsDir, missionId, nextApprovals);
      await mirrorMissionApprovals(paths.missionsDir, missionId, nextApprovals);
      await appendLedgerEvent(ledgerFilePath(missionDirectory(paths.missionsDir, missionId)), {
        missionId,
        type: decision === "approved" ? "tool.approved" : "tool.denied",
        summary: `Tool ${decision}: ${updated.toolName}`,
        details: {
          approvalId: updated.id,
          toolName: updated.toolName,
          reason
        },
        actor: options.actor,
        timestamp: now
      });

      return updated;
    },

    async markApprovalExecuted(id, checkpointId) {
      const found = await findApprovalById(paths.missionsDir, id);
      if (!found) {
        throw new Error(`Approval not found: ${id}`);
      }

      const { missionId, approvals, approval } = found;
      if (approval.status !== "approved") {
        throw new Error(`Approval ${id} is ${approval.status}, not approved.`);
      }

      if (approval.executedAt) {
        return approval;
      }

      const now = new Date().toISOString();
      const updated = approvalRequestSchema.parse({
        ...approval,
        updatedAt: now,
        executedAt: now,
        checkpointId
      });
      const nextApprovals = approvals.map((candidate) => (candidate.id === id ? updated : candidate));

      await writeApprovals(paths.missionsDir, missionId, nextApprovals);
      await mirrorMissionApprovals(paths.missionsDir, missionId, nextApprovals);

      return updated;
    }
  };
}

export async function readApprovals(filePath: string, options: { allowMissing?: boolean } = {}): Promise<ApprovalRequest[]> {
  let raw = "";

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" && options.allowMissing) {
      return [];
    }

    const message = error instanceof Error ? error.message : "Unknown approval read failure";
    throw new Error(`Failed to read approvals at ${filePath}: ${message}`);
  }

  try {
    const parsed = z.array(approvalRequestSchema).safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }

    return parsed.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid approvals JSON";
    throw new Error(`Failed to read approvals at ${filePath}: ${message}`);
  }
}

async function writeApprovals(missionsDir: string, missionId: string, approvals: ApprovalRequest[]): Promise<void> {
  const parsed = z.array(approvalRequestSchema).parse(approvals);
  await writeFile(approvalsFilePath(missionDirectory(missionsDir, missionId)), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function mirrorMissionApprovals(missionsDir: string, missionId: string, approvals: ApprovalRequest[]): Promise<void> {
  const filePath = missionFilePath(missionsDir, missionId);
  const raw = await readFile(filePath, "utf8");
  const mission = YAML.parse(raw) as Record<string, unknown>;
  mission.approvals = approvals;
  mission.updatedAt = new Date().toISOString();
  await writeFile(filePath, YAML.stringify(mission), "utf8");
}

async function findApprovalById(
  missionsDir: string,
  id: string
): Promise<{ missionId: string; approvals: ApprovalRequest[]; approval: ApprovalRequest } | undefined> {
  const entries = await readdir(missionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const approvals = await readApprovals(approvalsFilePath(missionDirectory(missionsDir, entry.name)), {
      allowMissing: true
    });
    const approval = approvals.find((candidate) => candidate.id === id);
    if (approval) {
      return {
        missionId: entry.name,
        approvals,
        approval
      };
    }
  }

  return undefined;
}

function formatApprovalPrompt(input: CreateApprovalInput): string {
  const target = input.target ?? targetFromToolInput(input.toolInput);
  return [
    `Action requires approval: ${input.toolName}`,
    `Mission: ${input.missionId}`,
    `Risk: ${input.riskLevel} - ${input.reason}`,
    target ? `Target: ${target}` : undefined,
    "",
    "Options:",
    "[a] approve once",
    "[d] deny"
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function targetFromToolInput(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "path" in input) {
    const value = (input as { path?: unknown }).path;
    return typeof value === "string" ? value : undefined;
  }

  return undefined;
}
