import { loadWorkspacePolicy } from "../config/load";
import type { WorkspacePaths } from "../config/workspace";
import { appendMemoryProposal, approveMemoryProposal, listPendingProposals, rejectMemoryProposal } from "./proposals";
import type { MemoryProposalStored } from "./schema";

export type PendingMemoryProposal = {
  id: string;
  ts: string;
  text: string;
  sessionId?: string;
  status: "pending" | "approved" | "rejected";
};

async function requirePolicy(paths: WorkspacePaths) {
  const r = await loadWorkspacePolicy(paths.policyFile);
  if (!r.ok) {
    throw new Error(`policy.yaml invalid: ${r.message}`);
  }
  return r.value;
}

function mapToPendingLegacy(p: MemoryProposalStored): PendingMemoryProposal {
  return {
    id: p.id,
    ts: p.updated_at,
    text: p.text,
    sessionId: p.source.companion_session_id,
    status: p.status === "pending" ? "pending" : p.status === "approved" ? "approved" : "rejected"
  };
}

export async function listPendingMemoryProposals(paths: WorkspacePaths): Promise<PendingMemoryProposal[]> {
  const rows = await listPendingProposals(paths);
  return rows.map((p) => ({ ...mapToPendingLegacy(p), status: "pending" as const }));
}

export async function appendPendingMemoryProposal(
  paths: WorkspacePaths,
  text: string,
  sessionId?: string
): Promise<PendingMemoryProposal> {
  const policy = await requirePolicy(paths);
  const stored = await appendMemoryProposal(paths, {
    scope: "relationship",
    text,
    source: { kind: "companion_explicit", companion_session_id: sessionId, citation: "companion.proposeMemory" },
    policy
  });
  return { ...mapToPendingLegacy(stored), status: "pending" };
}

export async function approvePendingMemoryProposal(paths: WorkspacePaths, id: string): Promise<boolean> {
  const policy = await requirePolicy(paths);
  return approveMemoryProposal(paths, id, policy);
}

export async function rejectPendingMemoryProposal(paths: WorkspacePaths, id: string): Promise<boolean> {
  return rejectMemoryProposal(paths, id);
}
