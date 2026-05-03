import type { Command } from "commander";

import { latestContextPacketLoggedMeta, resolveContextPacketAcrossWorkspace } from "../context/inspect";
import { compileContextPacket } from "../context/kernel";
import { renderWhy } from "../context/manifest";
import { loadContextDietConfig } from "../config/context-diet-config";
import { resolveWorkspacePaths } from "../config/workspace";
import { createMissionContextService } from "../missions/context";
import { buildModelContextPack, pruneStaleContextEntries } from "../missions/context-diet";

interface CliIo {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
}

function cliError(io: CliIo, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown failure";
  io.writeErr(`${message}\n`);
  process.exitCode = 1;
}

export function attachContextCommands(program: Command, cwd: string, io: CliIo): void {
  const contextService = createMissionContextService(cwd);

  const ctx = program
    .command("context")
    .description(
      "Mission context: notes, attachments, model pack snapshots, Frontier context kernel (packets + manifests)."
    );

  ctx
    .command("diet")
    .description("Show caps from context-diet.yaml and a kernel dry-run (does not persist to ledger).")
    .argument("<mission-id>", "Mission ID")
    .action(async (missionId: string) => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const diet = await loadContextDietConfig(paths.contextDietFile);
        if (!diet.ok) {
          throw new Error(`context-diet.yaml invalid: ${diet.message}`);
        }

        io.writeOut("context-diet.yaml (effective)\n");
        io.writeOut(`${JSON.stringify(diet.value, null, 2)}\n\n`);

        const { packet } = await compileContextPacket({
          cwd,
          missionId,
          trigger: { source: "cli" },
          persist: false
        });

        io.writeOut(renderWhy(packet));
        io.writeOut("\n");
      } catch (error) {
        cliError(io, error);
      }
    });

  ctx
    .command("inspect")
    .description("Load artifacts/context-packets/<id>.json and print the Frontier manifest (+ exclusions).")
    .argument("<packet-id>", 'Context packet id (e.g. "cpkt_…")')
    .option("-m, --mission <id>", "Prefer this mission when locating the artifact (faster)")
    .action(async (packetId: string, opts: { mission?: string }) => {
      try {
        const resolved = await resolveContextPacketAcrossWorkspace(cwd, packetId, opts.mission);
        if (!resolved) {
          throw new Error(`Context packet ${packetId} not found under any mission artifact store.`);
        }
        io.writeOut(`mission: ${resolved.missionId}\n\n`);
        io.writeOut(`${renderWhy(resolved.packet)}\n`);
      } catch (error) {
        cliError(io, error);
      }
    });

  ctx
    .argument("<mission-id>", "Mission ID — summary, mutate with flags, or --pack preview")
    .option("--note <text>", "Append a mission context note")
    .option("--file <path>", "Attach a safe local file to mission context")
    .option("--reason <text>", "Reason for attaching a file")
    .option("--pack", "Print model context pack summary (caps, truncation)")
    .option("--json", "With --pack, output JSON")
    .option("--prune-stale", "Remove stale file entries from context index (files only)")
    .action(
      async (
        missionId: string,
        commandOptions: {
          note?: string;
          file?: string;
          reason?: string;
          pack?: boolean;
          json?: boolean;
          pruneStale?: boolean;
        }
      ) => {
        try {
          const paths = resolveWorkspacePaths(cwd);
          if (commandOptions.pruneStale) {
            const pruned = await pruneStaleContextEntries(missionId, cwd);
            io.writeOut(`Pruned ${pruned} stale file context entr(y/ies).\n`);
          }

          if (commandOptions.note && commandOptions.file) {
            throw new Error("Use either --note or --file, not both.");
          }

          if (commandOptions.note) {
            await contextService.addNote(missionId, commandOptions.note);
            io.writeOut(`Context note added: ${missionId}\n`);
            io.writeOut(`${await contextService.renderContextSummary(missionId)}\n`);
            return;
          }

          if (commandOptions.file) {
            if (!commandOptions.reason) {
              throw new Error("--reason is required with --file.");
            }
            await contextService.addFile(missionId, commandOptions.file, commandOptions.reason);
            io.writeOut(`Context file attached: ${commandOptions.file}\n`);
            io.writeOut(`${await contextService.renderContextSummary(missionId)}\n`);
            return;
          }

          if (commandOptions.pack) {
            const diet = await loadContextDietConfig(paths.contextDietFile);
            if (!diet.ok) {
              throw new Error(`context-diet.yaml invalid: ${diet.message}`);
            }
            const pack = await buildModelContextPack(missionId, cwd, {
              trigger: { source: "cli" },
              recordLedger: false
            });
            if (commandOptions.json) {
              io.writeOut(
                JSON.stringify(
                  {
                    contextPacketId: pack.contextPacketId,
                    exclusionCounts: pack.exclusionCounts ?? {},
                    totals: pack.totals,
                    sensitiveContextIncluded: pack.sensitiveContextIncluded,
                    entries: pack.entries,
                    diet: diet.value
                  },
                  null,
                  2
                )
              );
              io.writeOut("\n");
              return;
            }

            io.writeOut(`Model context pack for ${missionId}\n`);
            if (pack.contextPacketId) {
              io.writeOut(`Context packet id: ${pack.contextPacketId}\n`);
            }
            if (pack.exclusionCounts && Object.keys(pack.exclusionCounts).length > 0) {
              io.writeOut(`Upstream exclusions by category: ${JSON.stringify(pack.exclusionCounts)}\n`);
            }
            io.writeOut(
              `Budget: ${pack.totals.bytes}/${diet.value.pack_max_bytes} bytes (est. tokens ${pack.totals.estimatedTokens}`
            );
            if (diet.value.pack_max_estimated_tokens !== undefined) {
              io.writeOut(` / ${diet.value.pack_max_estimated_tokens} cap`);
            }
            io.writeOut(")\n");
            io.writeOut(`Included: ${pack.totals.includedCount}, omitted: ${pack.totals.omittedCount}\n`);
            io.writeOut(`Sensitive context in pack: ${pack.sensitiveContextIncluded}\n\n`);
            io.writeOut(pack.packText ? `${pack.packText}\n` : "(empty pack)\n");
            return;
          }

          io.writeOut(`${await contextService.renderContextSummary(missionId)}\n`);

          const last = await latestContextPacketLoggedMeta(cwd, missionId);
          io.writeOut(
            last
              ? `\nLast persisted context packet: ${last.packetId} (inspect: narthynx context inspect ${last.packetId} -m ${missionId})\n`
              : "\n(No context.packet_logged entry yet — run with --pack to compile and persist, or invoke planning.)\n"
          );
        } catch (error) {
          cliError(io, error);
        }
      }
    );
}
