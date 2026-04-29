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
