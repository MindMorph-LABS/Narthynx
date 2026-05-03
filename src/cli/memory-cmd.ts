import path from "node:path";
import type { Command } from "commander";

import { loadWorkspacePolicy } from "../config/load";
import { resolveWorkspacePaths } from "../config/workspace";
import { detectMemoryConflicts, listOpenMemoryConflicts } from "../memory/conflicts";
import { exportMemoryWorkspace } from "../memory/export-delete";
import { approveMemoryProposal, rejectMemoryProposal } from "../memory/proposals";
import {
  listActiveMemoryItems,
  listMemoryRevisionLineage,
  revokeMemoryItem
} from "../memory/store";
import type { MemoryScope } from "../memory/schema";

interface CliIo {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
}

const MEMORY_SCOPES: MemoryScope[] = [
  "user",
  "relationship",
  "workspace",
  "mission",
  "procedural",
  "failure",
  "policy",
  "tool"
];

export function attachMemoryCommands(program: Command, cwd: string, io: CliIo): void {
  const memory = program
    .command("memory")
    .description(
      "Governed persistent memory (Frontier F18): items, proposals, export, heuristic conflict scan."
    );

  memory
    .command("list")
    .description("List active memory items (optionally filter by comma-separated scopes).")
    .option("--scope <scopes>", "e.g. user,relationship — default: policy-allowed scopes")
    .option("--limit <n>", "max rows", "50")
    .action(async (opts: { scope?: string; limit: string }) => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        let scopesFilter: MemoryScope[] | undefined;
        if (opts.scope?.trim()) {
          scopesFilter = opts.scope
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean) as MemoryScope[];
          for (const s of scopesFilter) {
            if (!MEMORY_SCOPES.includes(s)) {
              throw new Error(`Unknown scope "${s}" (${MEMORY_SCOPES.join(", ")})`);
            }
          }
        }

        const limit = Math.min(500, Math.max(0, Number(opts.limit) || 50));
        const rows = await listActiveMemoryItems(paths, scopesFilter?.length ? { scopes: scopesFilter, limit } : { limit });
        if (rows.length === 0) {
          io.writeOut("(no active memory rows)\n");
          return;
        }
        io.writeOut("memory items\n");
        for (const r of rows) {
          io.writeOut(
            `  ${r.id}  ${r.scope}${r.scope === "mission" && r.mission_id ? `:${r.mission_id}` : ""}  sensitivity=${r.sensitivity}  ${r.updated_at}\n`
          );
          io.writeOut(`    ${r.text.slice(0, 200)}${r.text.length > 200 ? "…" : ""}\n`);
        }
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "memory list failed"}\n`);
        process.exitCode = 1;
      }
    });

  memory
    .command("search")
    .description("Search active memory (substring match on text/tags).")
    .argument("<query>", "search string")
    .option("--limit <n>", "max rows", "30")
    .action(async (query: string, opts: { limit: string }) => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const limit = Math.min(500, Math.max(0, Number(opts.limit) || 30));
        const rows = await listActiveMemoryItems(paths, { query: query.trim(), limit });
        io.writeOut(`memory search (${rows.length})\n`);
        for (const r of rows) {
          io.writeOut(`  ${r.id}  ${r.scope}  ${r.updated_at}\n  ${r.text.slice(0, 240)}${r.text.length > 240 ? "…" : ""}\n`);
        }
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "memory search failed"}\n`);
        process.exitCode = 1;
      }
    });

  memory
    .command("approve")
    .description("Approve a pending memory proposal (writes an active item).")
    .argument("<proposalId>", "proposal id")
    .action(async (proposalId: string) => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const policy = await loadWorkspacePolicy(paths.policyFile);
        if (!policy.ok) {
          io.writeErr(`policy.yaml invalid: ${policy.message}\n`);
          process.exitCode = 1;
          return;
        }
        const ok = await approveMemoryProposal(paths, proposalId, policy.value);
        if (!ok) {
          io.writeErr(`Could not approve ${proposalId} (missing, not pending, or blocked policy).\n`);
          process.exitCode = 1;
          return;
        }
        io.writeOut(`Approved proposal ${proposalId}\n`);
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "memory approve failed"}\n`);
        process.exitCode = 1;
      }
    });

  memory
    .command("reject")
    .description("Reject a pending memory proposal.")
    .argument("<proposalId>", "proposal id")
    .action(async (proposalId: string) => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const ok = await rejectMemoryProposal(paths, proposalId);
        if (!ok) {
          io.writeErr(`Could not reject ${proposalId} (missing or not pending).\n`);
          process.exitCode = 1;
          return;
        }
        io.writeOut(`Rejected proposal ${proposalId}\n`);
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "memory reject failed"}\n`);
        process.exitCode = 1;
      }
    });

  memory
    .command("delete")
    .description("Revoke an active memory item by id (append-only tombstone).")
    .argument("<itemId>", "memory item id")
    .action(async (itemId: string) => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const ok = await revokeMemoryItem(paths, itemId);
        if (!ok) {
          io.writeErr(`Could not revoke ${itemId}\n`);
          process.exitCode = 1;
          return;
        }
        io.writeOut(`Revoked memory item ${itemId}\n`);
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "memory delete failed"}\n`);
        process.exitCode = 1;
      }
    });

  memory
    .command("export")
    .description("Export active memory + all proposal revisions bundle to JSON under .narthynx/memory/exports/.")
    .action(async () => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const out = await exportMemoryWorkspace(paths);
        io.writeOut(`Wrote export: ${path.relative(cwd, out)}\n`);
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "memory export failed"}\n`);
        process.exitCode = 1;
      }
    });

  memory
    .command("conflicts")
    .description("List persisted open conflicts + run a local heuristic similarity scan.")
    .action(async () => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const open = await listOpenMemoryConflicts(paths);
        io.writeOut(`Open recorded conflicts (${open.length})\n`);
        for (const c of open) {
          io.writeOut(`  ${c.id}: ${c.item_ids.join(" vs ")} — ${c.reason}\n`);
        }

        const items = await listActiveMemoryItems(paths);
        const pairs = detectMemoryConflicts(items);
        io.writeOut(`Heuristic overlaps (not auto-recorded) (${pairs.length})\n`);
        for (const p of pairs.slice(0, 25)) {
          io.writeOut(
            `  sim=${p.similarity.toFixed(2)}  ${p.a.id} (${p.a.scope}) <> ${p.b.id} (${p.b.scope})\n  A:${p.a.text.slice(0, 90)}…\n  B:${p.b.text.slice(0, 90)}…\n`
          );
        }
        if (pairs.length > 25) {
          io.writeOut(`…and ${pairs.length - 25} more\n`);
        }
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "memory conflicts failed"}\n`);
        process.exitCode = 1;
      }
    });

  memory
    .command("diff")
    .description("Show latest revision texts for two memory item ids.")
    .argument("<idA>", "first memory id")
    .argument("<idB>", "second memory id")
    .action(async (idA: string, idB: string) => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const left = await listMemoryRevisionLineage(paths, idA);
        const right = await listMemoryRevisionLineage(paths, idB);
        if (left.length === 0) {
          io.writeErr(`No revisions for ${idA}\n`);
          process.exitCode = 1;
          return;
        }
        if (right.length === 0) {
          io.writeErr(`No revisions for ${idB}\n`);
          process.exitCode = 1;
          return;
        }
        const la = left[left.length - 1]!;
        const rb = right[right.length - 1]!;
        io.writeOut(`--- ${idA} (latest at ${la.updated_at})\n${la.text}\n\n`);
        io.writeOut(`--- ${idB} (latest at ${rb.updated_at})\n${rb.text}\n`);
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "memory diff failed"}\n`);
        process.exitCode = 1;
      }
    });
}
