import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";
import { z } from "zod";

import { resolveWorkspacePaths } from "../config/workspace";
import { createArtifactId } from "../utils/ids";
import { appendLedgerEvent, ledgerFilePath } from "./ledger";
import type { Mission } from "./schema";
import { missionDirectory, missionFilePath } from "./store";

export const ARTIFACTS_DIR_NAME = "artifacts";

export const artifactSchema = z.object({
  id: z.string().regex(/^art_[a-z0-9_-]+$/),
  missionId: z.string().regex(/^m_[a-z0-9_-]+$/),
  type: z.literal("report"),
  path: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional()
});

export type Artifact = z.infer<typeof artifactSchema>;

export interface RegisterReportArtifactInput {
  missionId: string;
  title: string;
  relativePath?: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactStore {
  registerReportArtifact(input: RegisterReportArtifactInput): Promise<{ artifact: Artifact; regenerated: boolean }>;
  readMissionArtifacts(missionId: string): Promise<Artifact[]>;
}

export function artifactsDirPath(missionDir: string): string {
  return path.join(missionDir, ARTIFACTS_DIR_NAME);
}

export function reportArtifactPath(missionDir: string): string {
  return path.join(artifactsDirPath(missionDir), "report.md");
}

export function createArtifactStore(cwd = process.cwd()): ArtifactStore {
  const paths = resolveWorkspacePaths(cwd);

  return {
    async registerReportArtifact(input) {
      const existing = await this.readMissionArtifacts(input.missionId);
      const previous = existing.find((artifact) => artifact.type === "report" && artifact.path === (input.relativePath ?? "artifacts/report.md"));
      const now = new Date().toISOString();
      const artifact = artifactSchema.parse({
        id: previous?.id ?? createArtifactId(),
        missionId: input.missionId,
        type: "report",
        path: input.relativePath ?? "artifacts/report.md",
        title: input.title,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        metadata: input.metadata
      });
      const artifacts = [...existing.filter((candidate) => candidate.id !== artifact.id), artifact].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      );

      await mirrorMissionArtifacts(paths.missionsDir, input.missionId, artifacts);
      await appendLedgerEvent(ledgerFilePath(missionDirectory(paths.missionsDir, input.missionId)), {
        missionId: input.missionId,
        type: "artifact.created",
        summary: previous ? `Report artifact regenerated: ${artifact.path}` : `Report artifact created: ${artifact.path}`,
        details: {
          artifactId: artifact.id,
          path: artifact.path,
          regenerated: Boolean(previous)
        },
        timestamp: artifact.updatedAt
      });

      return {
        artifact,
        regenerated: Boolean(previous)
      };
    },

    async readMissionArtifacts(missionId) {
      const raw = await readFile(missionFilePath(paths.missionsDir, missionId), "utf8");
      const mission = YAML.parse(raw) as Mission;
      return z.array(artifactSchema).parse(mission.artifacts ?? []);
    }
  };
}

export async function writeReportArtifact(cwd: string, missionId: string, content: string): Promise<string> {
  const paths = resolveWorkspacePaths(cwd);
  const filePath = reportArtifactPath(missionDirectory(paths.missionsDir, missionId));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
}

async function mirrorMissionArtifacts(missionsDir: string, missionId: string, artifacts: Artifact[]): Promise<void> {
  const filePath = missionFilePath(missionsDir, missionId);
  const raw = await readFile(filePath, "utf8");
  const mission = YAML.parse(raw) as Record<string, unknown>;
  mission.artifacts = artifacts;
  mission.updatedAt = new Date().toISOString();
  await writeFile(filePath, YAML.stringify(mission), "utf8");
}
