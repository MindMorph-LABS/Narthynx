import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";
import { z } from "zod";

import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspaceActor } from "../config/identity-config";
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
  addedAt: z.string().datetime(),
  contentSha256: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/)
    .optional(),
  sourceMtimeMs: z.number().optional(),
  role: z.string().optional(),
  tags: z.array(z.string()).optional(),
  inlineBytes: z.number().int().nonnegative().optional(),
  originalBytes: z.number().int().nonnegative().optional(),
  duplicateOf: z.string().optional(),
  refCount: z.number().int().positive().optional()
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

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function readMissionContextIndex(cwd: string, missionId: string): Promise<ContextIndex> {
  const paths = resolveWorkspacePaths(cwd);
  return readContextIndexFromPaths(paths.missionsDir, missionId);
}

export async function writeMissionContextIndex(cwd: string, index: ContextIndex): Promise<void> {
  const paths = resolveWorkspacePaths(cwd);
  await writeContextIndexToPaths(paths.missionsDir, index);
}

export function createMissionContextService(cwd = process.cwd()) {
  const paths = resolveWorkspacePaths(cwd);
  const missionStore = createMissionStore(cwd);

  async function ledgerActor() {
    return resolveWorkspaceActor(paths.identityFile);
  }

  return {
    async summarizeContext(missionId: string): Promise<ContextSummary> {
      await missionStore.readMission(missionId);
      const index = await readContextIndexFromPaths(paths.missionsDir, missionId);
      const bytes = index.entries.reduce((total, entry) => total + entry.bytes, 0);
      return {
        missionId,
        notes: index.entries.filter((entry) => entry.type === "note").length,
        files: index.entries.filter((entry) => entry.type === "file").length,
        bytes,
        estimatedTokens: estimateTokensFromBytes(bytes),
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
          summary.entries.map((entry) => {
            const dup = entry.duplicateOf ? ` duplicateOf=${entry.duplicateOf}` : "";
            const hash = entry.contentSha256 ? ` sha256=${entry.contentSha256.slice(0, 12)}…` : "";
            return `- ${entry.type}: ${entry.source} (${entry.reason}, ${entry.bytes} bytes)${hash}${dup}`;
          }),
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
      const hash = sha256Utf8(trimmed);
      const indexBefore = await readContextIndexFromPaths(paths.missionsDir, missionId);

      const canonicalIndex = indexBefore.entries.findIndex(
        (candidate) =>
          candidate.type === "note" && candidate.contentSha256 === hash && !candidate.duplicateOf
      );

      if (canonicalIndex >= 0) {
        const canonical = indexBefore.entries[canonicalIndex];
        const updatedCanonical: ContextEntry = {
          ...canonical,
          refCount: (canonical.refCount ?? 1) + 1
        };
        const dupEntry: ContextEntry = {
          type: "note",
          source: "mission-note",
          reason: "user note (same content as earlier note)",
          bytes: 0,
          addedAt: now,
          contentSha256: hash,
          duplicateOf: `note:${canonical.addedAt}`
        };
        const nextEntries = [...indexBefore.entries];
        nextEntries[canonicalIndex] = updatedCanonical;
        nextEntries.push(dupEntry);
        const updatedIndex = contextIndexSchema.parse({ missionId, entries: nextEntries });
        await writeContextIndexToPaths(paths.missionsDir, updatedIndex);

        await appendContextMarkdown(missionId, [`## Note (duplicate) - ${now}`, "", `Same content as note at ${canonical.addedAt}.`, ""]);

        await mirrorMissionContext(mission, {
          notes: [...mission.context.notes, trimmed],
          files: mission.context.files
        });
        const actor = await ledgerActor();
        await appendLedgerEvent(ledgerPath(missionId), {
          missionId,
          type: "user.note",
          summary: "Context note added (deduplicated by content hash).",
          details: {
            bytes,
            contextEntries: updatedIndex.entries.length,
            duplicateOf: canonical.addedAt
          },
          actor,
          timestamp: now
        });

        return this.summarizeContext(missionId);
      }

      const entry: ContextEntry = {
        type: "note",
        source: "mission-note",
        reason: "user note",
        bytes,
        addedAt: now,
        contentSha256: hash
      };

      await appendContextMarkdown(missionId, [`## Note - ${now}`, "", trimmed, ""]);
      const index = await upsertContextEntry(missionId, entry, false);
      await mirrorMissionContext(mission, {
        notes: [...mission.context.notes, trimmed],
        files: mission.context.files
      });
      const actor = await ledgerActor();
      await appendLedgerEvent(ledgerPath(missionId), {
        missionId,
        type: "user.note",
        summary: "Context note added.",
        details: {
          bytes,
          contextEntries: index.entries.length
        },
        actor,
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

      const actor = await ledgerActor();
      const guarded = resolveGuardedWorkspacePath(cwd, requestedPath, policy.value);
      const target = await stat(guarded.absolutePath);
      if (!target.isFile()) {
        throw new Error(`Context path is not a file: ${requestedPath}`);
      }

      const content = await readFile(guarded.absolutePath, "utf8");
      const now = new Date().toISOString();
      const bytes = Buffer.byteLength(content, "utf8");
      const hash = sha256Utf8(content);
      const sourceMtimeMs = Math.trunc(target.mtimeMs);

      const indexBefore = await readContextIndexFromPaths(paths.missionsDir, missionId);
      const samePathIndex = indexBefore.entries.findIndex(
        (candidate) => candidate.type === "file" && candidate.source === guarded.relativePath
      );

      if (samePathIndex >= 0) {
        const updatedEntry: ContextEntry = {
          type: "file",
          source: guarded.relativePath,
          reason: trimmedReason,
          bytes,
          addedAt: now,
          contentSha256: hash,
          sourceMtimeMs
        };
        const nextEntries = [...indexBefore.entries];
        nextEntries[samePathIndex] = updatedEntry;
        const updated = contextIndexSchema.parse({ missionId, entries: nextEntries });
        await writeContextIndexToPaths(paths.missionsDir, updated);

        await mirrorMissionContext(mission, {
          notes: mission.context.notes,
          files: [...mission.context.files.filter((file) => file !== guarded.relativePath), guarded.relativePath]
        });
        await appendLedgerEvent(ledgerPath(missionId), {
          missionId,
          type: "user.note",
          summary: `Context file re-attached: ${guarded.relativePath}`,
          details: {
            path: guarded.relativePath,
            reason: trimmedReason,
            bytes,
            duplicate: true
          },
          actor,
          timestamp: now
        });

        return this.summarizeContext(missionId);
      }

      const canonicalFile = indexBefore.entries.find(
        (candidate) =>
          candidate.type === "file" && candidate.contentSha256 === hash && !candidate.duplicateOf
      );

      if (canonicalFile) {
        const dupEntry: ContextEntry = {
          type: "file",
          source: guarded.relativePath,
          reason: trimmedReason,
          bytes: 0,
          addedAt: now,
          contentSha256: hash,
          sourceMtimeMs,
          duplicateOf: canonicalFile.source
        };
        const updatedCanonical: ContextEntry = {
          ...canonicalFile,
          refCount: (canonicalFile.refCount ?? 1) + 1
        };
        const replaced = indexBefore.entries.map((e) =>
          e.type === "file" && e.source === canonicalFile.source ? updatedCanonical : e
        );
        const withDup = [...replaced, dupEntry];
        const updated = contextIndexSchema.parse({ missionId, entries: withDup });
        await writeContextIndexToPaths(paths.missionsDir, updated);

        await appendContextMarkdown(missionId, [
          `## File (duplicate content) - ${guarded.relativePath}`,
          "",
          `Same bytes as \`${canonicalFile.source}\` (sha256 \`${hash.slice(0, 12)}…\`).`,
          ""
        ]);

        await mirrorMissionContext(mission, {
          notes: mission.context.notes,
          files: [...mission.context.files.filter((file) => file !== guarded.relativePath), guarded.relativePath]
        });
        await appendLedgerEvent(ledgerPath(missionId), {
          missionId,
          type: "user.note",
          summary: `Context file attached (deduplicated by hash): ${guarded.relativePath}`,
          details: {
            path: guarded.relativePath,
            canonicalPath: canonicalFile.source,
            bytes: 0
          },
          actor,
          timestamp: now
        });

        return this.summarizeContext(missionId);
      }

      const entry: ContextEntry = {
        type: "file",
        source: guarded.relativePath,
        reason: trimmedReason,
        bytes,
        addedAt: now,
        contentSha256: hash,
        sourceMtimeMs
      };

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

      await upsertContextEntry(missionId, entry, true);
      await mirrorMissionContext(mission, {
        notes: mission.context.notes,
        files: [...mission.context.files.filter((file) => file !== guarded.relativePath), guarded.relativePath]
      });
      await appendLedgerEvent(ledgerPath(missionId), {
        missionId,
        type: "user.note",
        summary: `Context file attached: ${guarded.relativePath}`,
        details: {
          path: guarded.relativePath,
          reason: trimmedReason,
          bytes,
          duplicate: false
        },
        actor,
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

  function ledgerPath(missionId: string): string {
    return ledgerFilePath(missionDir(missionId));
  }

  async function readContextIndex(missionId: string): Promise<ContextIndex> {
    return readContextIndexFromPaths(paths.missionsDir, missionId);
  }

  async function writeContextIndex(index: ContextIndex): Promise<void> {
    await writeContextIndexToPaths(paths.missionsDir, index);
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

async function readContextIndexFromPaths(missionsDir: string, missionId: string): Promise<ContextIndex> {
  const filePath = path.join(missionDirectory(missionsDir, missionId), CONTEXT_INDEX_FILE_NAME);
  try {
    const raw = await readFile(filePath, "utf8");
    return contextIndexSchema.parse(JSON.parse(raw));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
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

async function writeContextIndexToPaths(missionsDir: string, index: ContextIndex): Promise<void> {
  const filePath = path.join(missionDirectory(missionsDir, index.missionId), CONTEXT_INDEX_FILE_NAME);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(contextIndexSchema.parse(index), null, 2)}\n`, "utf8");
}

function listOrFallback(values: string[], fallback: string): string[] {
  return values.length > 0 ? values : [`- ${fallback}`];
}
