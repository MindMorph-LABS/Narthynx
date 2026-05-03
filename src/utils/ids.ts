import { randomUUID } from "node:crypto";

export function createMissionId(): string {
  return `m_${randomUUID()}`;
}

export function createLedgerEventId(): string {
  return `e_${randomUUID()}`;
}

export function createApprovalId(): string {
  return `a_${randomUUID()}`;
}

export function createCheckpointId(): string {
  return `c_${randomUUID()}`;
}

export function createArtifactId(): string {
  return `art_${randomUUID()}`;
}

export function createTriggerEventId(): string {
  return `e_trig_${randomUUID()}`;
}

export function createDaemonJobId(): string {
  return `qj_${randomUUID()}`;
}

export function createDaemonEventRowId(): string {
  return `de_${randomUUID()}`;
}

export function createCompanionRowId(prefix: "cmsg" | "csug" | "crm" | "cmem" | "cpend"): string {
  return `${prefix}_${randomUUID()}`;
}

export function createMemoryItemId(): string {
  return `mem_${randomUUID()}`;
}

export function createMemoryProposalId(): string {
  return `mprop_${randomUUID()}`;
}

export function createMemoryConflictId(): string {
  return `mcf_${randomUUID()}`;
}
