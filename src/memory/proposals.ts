import { appendFile, mkdir, readFile } from "node:fs/promises";

import type { WorkspacePaths } from "../config/workspace";
import type { WorkspacePolicy } from "../config/load";
import { createMemoryProposalId } from "../utils/ids";
import type { MemoryProposalStored } from "./schema";
import { MEMORY_PROPOSAL_RECORD, memoryProposalStoredSchema } from "./schema";
import { appendMemoryItem } from "./store";
import { classifyMemorySensitivity } from "./extractor";
import { maybeMigrateFromCompanionLegacy } from "./migrate";

export async function loadProposalRevisions(paths: WorkspacePaths): Promise<MemoryProposalStored[]> {
  await maybeMigrateFromCompanionLegacy(paths);
  let raw = "";
  try {
    raw = await readFile(paths.memoryProposalsFile, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const out: MemoryProposalStored[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const r = memoryProposalStoredSchema.safeParse(JSON.parse(line));
      if (r.success) {
        out.push(r.data);
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Latest revision per proposal id wins. */
export function mergeLatestProposals(revisions: MemoryProposalStored[]): Map<string, MemoryProposalStored> {
  const sorted = [...revisions].sort((a, b) => {
    const c = a.updated_at.localeCompare(b.updated_at);
    return c !== 0 ? c : a.created_at.localeCompare(b.created_at);
  });
  const map = new Map<string, MemoryProposalStored>();
  for (const rev of sorted) {
    map.set(rev.id, rev);
  }
  return map;
}

export async function listPendingProposals(paths: WorkspacePaths): Promise<MemoryProposalStored[]> {
  return [...mergeLatestProposals(await loadProposalRevisions(paths)).values()].filter((p) => p.status === "pending");
}

export interface AppendProposalInput {
  scope: MemoryProposalStored["scope"];
  mission_id?: string;
  text: string;
  source: MemoryProposalStored["source"];
  policy: WorkspacePolicy;
  sensitivityOverride?: MemoryProposalStored["sensitivity"];
}

export async function appendMemoryProposal(paths: WorkspacePaths, input: AppendProposalInput): Promise<MemoryProposalStored> {
  if (input.policy.memory_storage === "off") {
    throw new Error("Memory storage is disabled (policy memory_storage: off).");
  }

  const sensitivity = input.sensitivityOverride ?? classifyMemorySensitivity(input.text);

  if (sensitivity === "sensitive" && input.policy.memory_sensitive_behavior === "block") {
    throw new Error(
      "This text looks sensitive and policy memory_sensitive_behavior is block — not queued as a memory proposal."
    );
  }

  const now = new Date().toISOString();
  const row = memoryProposalStoredSchema.parse({
    schema: MEMORY_PROPOSAL_RECORD,
    id: createMemoryProposalId(),
    created_at: now,
    updated_at: now,
    scope: input.scope,
    mission_id: input.mission_id,
    text: input.text.trim(),
    sensitivity,
    status: "pending",
    source: input.source
  });

  await mkdir(paths.memoryDir, { recursive: true });
  await appendFile(paths.memoryProposalsFile, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

export async function rejectMemoryProposal(paths: WorkspacePaths, id: string): Promise<boolean> {
  const merged = mergeLatestProposals(await loadProposalRevisions(paths));
  const latest = merged.get(id);
  if (!latest || latest.status !== "pending") {
    return false;
  }
  const now = new Date().toISOString();
  const next = memoryProposalStoredSchema.parse({
    ...latest,
    updated_at: now,
    status: "rejected"
  });
  await mkdir(paths.memoryDir, { recursive: true });
  await appendFile(paths.memoryProposalsFile, `${JSON.stringify(next)}\n`, "utf8");
  return true;
}

export async function approveMemoryProposal(paths: WorkspacePaths, id: string, policy: WorkspacePolicy): Promise<boolean> {
  const merged = mergeLatestProposals(await loadProposalRevisions(paths));
  const latest = merged.get(id);
  if (!latest || latest.status !== "pending") {
    return false;
  }

  if (latest.sensitivity === "sensitive" && policy.memory_sensitive_behavior === "block") {
    return false;
  }

  const now = new Date().toISOString();
  const approvedRow: MemoryProposalStored = memoryProposalStoredSchema.parse({
    ...latest,
    updated_at: now,
    status: "approved"
  });
  await mkdir(paths.memoryDir, { recursive: true });
  await appendFile(paths.memoryProposalsFile, `${JSON.stringify(approvedRow)}\n`, "utf8");

  await appendMemoryItem(paths, {
    scope: latest.scope,
    mission_id: latest.mission_id,
    text: latest.text,
    sensitivity: latest.sensitivity,
    source: {
      ...latest.source,
      citation: latest.source.citation ?? `proposal:${latest.id}`
    },
    policy
  });

  return true;
}
