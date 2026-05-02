import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";
import { z } from "zod";

import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { resolveGuardedWorkspacePath } from "../tools/path-guard";
import { appendLedgerEvent, ledgerFilePath } from "./ledger";
import type { Mission } from "./schema";
import { createMissionStore, missionDirectory, missionFilePath } from "./store";

const CONTEXT_FILE_NAME = "context.md";
const CONTEXT_INDEX_FILE_NAME = "context.json";

const contextEntrySchema = z.object({
  type: z.enum(["note", "file"]),
  source: z.string(),
  reason: z.string(),
  bytes: z.number().int().nonnegative(),
  addedAt: z.string().datetime()
});

const contextIndexSchema = z.object({
  missionId: z.string().regex(/^m_[a-z0-9_-]+$/),
  entries: z.array(contextEntrySchema)
});

export type ContextEntry = z.infer<typeof contextEntrySchema>;
export type ContextIndex = z.infer<typeof contextIndexSchema>;

export interface ContextSummary {
  missionId: string;
  notes: number;
  files: number;
  bytes: number;
  estimatedTokens: number;
  entries: ContextEntry[];
  path: string;
}

export function createMissionContextService(cwd = process.cwd()) {
  const paths = resolveWorkspacePaths(cwd);
  const missionStore = createMissionStore(cwd);

  return {
    async summarizeContext(missionId: string): Promise<ContextSummary> {
      await missionStore.readMission(missionId);
      const index = await readContextIndex(missionId);
      const bytes = index.entries.reduce((total, entry) => total + entry.bytes, 0);
      return {
        missionId,
        notes: index.entries.filter((entry) => entry.type === "note").length,
        files: index.entries.filter((entry) => entry.type === "file").length,
        bytes,
        estimatedTokens: estimateTokens(bytes),
        entries: index.entries,
        path: contextFilePath(missionId)
      };
    },

    async renderContextSummary(missionId: string): Promise<string> {
      const summary = await this.summarizeContext(missionId);
      return [
        `Context for ${missionId}`,
        `path: ${summary.path}`,
        `notes: ${summary.notes}`,
        `files: ${summary.files}`,
        `bytes: ${summary.bytes}`,
        `estimated tokens: ${summary.estimatedTokens}`,
        "sources:",
        ...listOrFallback(
          summary.entries.map((entry) => `- ${entry.type}: ${entry.source} (${entry.reason}, ${entry.bytes} bytes)`),
          "No context entries recorded."
        )
      ].join("\n");
    },

    async addNote(missionId: string, note: string): Promise<ContextSummary> {
      const trimmed = note.trim();
      if (!trimmed) {
        throw new Error("Context note is required.");
      }

      const mission = await missionStore.readMission(missionId);
      const now = new Date().toISOString();
      const bytes = Buffer.byteLength(trimmed, "utf8");
      const entry: ContextEntry = {
        type: "note",
        source: "mission-note",
        reason: "user note",
        bytes,
        addedAt: now
      };

      await appendContextMarkdown(missionId, [`## Note - ${now}`, "", trimmed, ""]);
      const index = await upsertContextEntry(missionId, entry, false);
      await mirrorMissionContext(mission, {
        notes: [...mission.context.notes, trimmed],
        files: mission.context.files
      });
      await appendLedgerEvent(ledgerPath(missionId), {
        missionId,
        type: "user.note",
        summary: "Context note added.",
        details: {
          bytes,
          contextEntries: index.entries.length
        },
        timestamp: now
      });

      return this.summarizeContext(missionId);
    },

    async addFile(missionId: string, requestedPath: string, reason: string): Promise<ContextSummary> {
      const trimmedReason = reason.trim();
      if (!trimmedReason) {
        throw new Error("Context file reason is required.");
      }

      const mission = await missionStore.readMission(missionId);
      const policy = await loadWorkspacePolicy(paths.policyFile);
      if (!policy.ok) {
        throw new Error(`policy.yaml invalid: ${policy.message}`);
      }

      const guarded = resolveGuardedWorkspacePath(cwd, requestedPath, policy.value);
      const target = await stat(guarded.absolutePath);
      if (!target.isFile()) {
        throw new Error(`Context path is not a file: ${requestedPath}`);
      }

      const content = await readFile(guarded.absolutePath, "utf8");
      const now = new Date().toISOString();
      const bytes = Buffer.byteLength(content, "utf8");
      const entry: ContextEntry = {
        type: "file",
        source: guarded.relativePath,
        reason: trimmedReason,
        bytes,
        addedAt: now
      };
      const indexBefore = await readContextIndex(missionId);
      const duplicate = indexBefore.entries.some((candidate) => candidate.type === "file" && candidate.source === guarded.relativePath);

      if (!duplicate) {
        await appendContextMarkdown(missionId, [
          `## File - ${guarded.relativePath}`,
          "",
          `Reason: ${trimmedReason}`,
          `Bytes: ${bytes}`,
          "",
          "```txt",
          content,
          "```",
          ""
        ]);
      }

      await upsertContextEntry(missionId, entry, true);
      await mirrorMissionContext(mission, {
        notes: mission.context.notes,
        files: [...mission.context.files.filter((file) => file !== guarded.relativePath), guarded.relativePath]
      });
      await appendLedgerEvent(ledgerPath(missionId), {
        missionId,
        type: "user.note",
        summary: duplicate ? `Context file already attached: ${guarded.relativePath}` : `Context file attached: ${guarded.relativePath}`,
        details: {
          path: guarded.relativePath,
          reason: trimmedReason,
          bytes,
          duplicate
        },
        timestamp: now
      });

      return this.summarizeContext(missionId);
    }
  };

  function missionDir(missionId: string): string {
    return missionDirectory(paths.missionsDir, missionId);
  }

  function contextFilePath(missionId: string): string {
    return path.join(missionDir(missionId), CONTEXT_FILE_NAME);
  }

  function contextIndexPath(missionId: string): string {
    return path.join(missionDir(missionId), CONTEXT_INDEX_FILE_NAME);
  }

  function ledgerPath(missionId: string): string {
    return ledgerFilePath(missionDir(missionId));
  }

  async function readContextIndex(missionId: string): Promise<ContextIndex> {
    const filePath = contextIndexPath(missionId);
    try {
      const raw = await readFile(filePath, "utf8");
      return contextIndexSchema.parse(JSON.parse(raw));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") {
        return {
          missionId,
          entries: []
        };
      }

      const message = error instanceof Error ? error.message : "Unknown context read failure";
      throw new Error(`Failed to read context index at ${filePath}: ${message}`);
    }
  }

  async function writeContextIndex(index: ContextIndex): Promise<void> {
    const filePath = contextIndexPath(index.missionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(contextIndexSchema.parse(index), null, 2)}\n`, "utf8");
  }

  async function upsertContextEntry(missionId: string, entry: ContextEntry, dedupeBySource: boolean): Promise<ContextIndex> {
    const index = await readContextIndex(missionId);
    const entries = dedupeBySource
      ? [...index.entries.filter((candidate) => !(candidate.type === entry.type && candidate.source === entry.source)), entry]
      : [...index.entries, entry];
    const updated = contextIndexSchema.parse({
      missionId,
      entries
    });
    await writeContextIndex(updated);
    return updated;
  }

  async function appendContextMarkdown(missionId: string, lines: string[]): Promise<void> {
    const filePath = contextFilePath(missionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const existing = await readFile(filePath, "utf8").catch(() => `# Mission Context\n\nMission: ${missionId}\n\n`);
    await writeFile(filePath, `${existing}${lines.join("\n")}\n`, "utf8");
  }

  async function mirrorMissionContext(mission: Mission, context: Mission["context"]): Promise<void> {
    const updated: Mission = {
      ...mission,
      context,
      updatedAt: new Date().toISOString()
    };
    await writeFile(missionFilePath(paths.missionsDir, mission.id), YAML.stringify(updated), "utf8");
  }
}

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function listOrFallback(values: string[], fallback: string): string[] {
  return values.length > 0 ? values : [`- ${fallback}`];
}
