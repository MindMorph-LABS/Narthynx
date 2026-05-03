import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveWorkspacePaths } from "../config/workspace";
import type { LedgerEvent } from "../missions/ledger";
import { ledgerFilePath, readLedgerEvents } from "../missions/ledger";
import { createMissionStore, missionDirectory } from "../missions/store";
import { packetArtifactRelativePath } from "./manifest";
import { contextPacketSchema, type ContextPacket } from "./types";

function artifactAbsolutePath(missionDir: string, packetId: string): string {
  const relPosix = packetArtifactRelativePath(packetId);
  return path.join(missionDir, ...relPosix.split("/"));
}

export async function loadContextPacketFromArtifact(
  missionDir: string,
  packetId: string
): Promise<ContextPacket | null> {
  const fp = artifactAbsolutePath(missionDir, packetId);
  try {
    const raw = await readFile(fp, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const r = contextPacketSchema.safeParse(parsed);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Latest `context.packet_logged` row for this mission (by ledger order). */
export async function latestContextPacketLoggedMeta(
  cwd: string,
  missionId: string
): Promise<{ packetId: string; event: LedgerEvent } | null> {
  const paths = resolveWorkspacePaths(cwd);
  const dir = missionDirectory(paths.missionsDir, missionId);
  const entries = await readLedgerEvents(ledgerFilePath(dir), { allowMissing: true });
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const e = entries[index]!;
    if (e.type !== "context.packet_logged") {
      continue;
    }
    const d = e.details;
    if (d && typeof d === "object" && "packet_id" in d && typeof (d as { packet_id: unknown }).packet_id === "string") {
      return { packetId: (d as { packet_id: string }).packet_id, event: e };
    }
  }
  return null;
}

export async function resolveContextPacketAcrossWorkspace(
  cwd: string,
  packetId: string,
  missionHint?: string
): Promise<{ missionId: string; packet: ContextPacket } | null> {
  const paths = resolveWorkspacePaths(cwd);
  const tryMission = async (mid: string) => {
    const dir = missionDirectory(paths.missionsDir, mid);
    const pkt = await loadContextPacketFromArtifact(dir, packetId);
    return pkt?.id === packetId ? pkt : null;
  };

  if (missionHint) {
    const pkt = await tryMission(missionHint);
    if (pkt) {
      return { missionId: missionHint, packet: pkt };
    }
  }

  const store = createMissionStore(cwd);
  const missions = await store.listMissions();
  const ordered = [...missions].reverse();
  for (const m of ordered) {
    if (missionHint && m.id === missionHint) {
      continue;
    }
    const pkt = await tryMission(m.id);
    if (pkt) {
      return { missionId: m.id, packet: pkt };
    }
  }

  return null;
}
