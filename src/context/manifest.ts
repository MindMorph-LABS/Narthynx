import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ContextPacket } from "./types";

export function packetArtifactRelativePath(packetId: string): string {
  return path.posix.join("artifacts/context-packets", `${packetId}.json`);
}

export async function writeContextPacketArtifact(
  missionDir: string,
  packet: ContextPacket
): Promise<{ absolutePath: string; relativePath: string }> {
  const dir = path.join(missionDir, "artifacts", "context-packets");
  await mkdir(dir, { recursive: true });
  const rel = packetArtifactRelativePath(packet.id).replace(/\//g, path.sep);
  const absolutePath = path.join(missionDir, rel);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  const relativePath = path.posix.join("artifacts/context-packets", `${packet.id}.json`);
  return { absolutePath, relativePath };
}

export function renderWhy(packet: ContextPacket): string {
  const lines = [
    `Context packet ${packet.id}`,
    `mission: ${packet.missionId}  trigger: ${packet.trigger.source}${
      packet.trigger.planNodeId ? ` (${packet.trigger.planNodeId})` : ""
    }`,
    `included: ${packet.totals.includedCount}  omitted: ${packet.totals.omittedCount}  exclusions(recorded upstream): ${packet.excluded?.length ?? 0}`,
    `bytes: ${packet.totals.bytes}  est.tokens: ${packet.totals.estimatedTokens}`,
    `sensitiveContextIncluded: ${packet.sensitiveContextIncluded}`,
    "",
    "Excluded (policy / unreadable):",
    ...(packet.excluded.length > 0
      ? packet.excluded.map((e) => `  - ${e.category}: ${e.label}${e.detail ? ` (${e.detail})` : ""}`)
      : ["  (none)"]),
    "",
    "Included items:",
    ...packet.items
      .filter((i) => i.included && i.text.length > 0)
      .map((i) => `  [${i.kind}] ${i.label}  sens=${i.sensitivity}  reason=${i.reasonIncluded ?? "n/a"}`),
    "",
    "Omitted / zero-byte placeholders:",
    ...packet.items
      .filter((i) => !i.included || i.text.length === 0)
      .map((i) => `  [${i.kind}] ${i.label}  ${i.omitReason ?? "(empty placeholder)"}`)
  ];
  return lines.join("\n");
}
