import { readFile } from "node:fs/promises";
import path from "node:path";
import { stdin } from "node:process";

import type { Command } from "commander";

import { VAULT_KDF_SALT_FILE_NAME } from "../config/defaults";
import { resolveWorkspacePaths } from "../config/workspace";
import { resolveVaultPassphrase } from "../missions/vault-passphrase";
import {
  ensureVaultKdfSaltBytes,
  rekeyAllVaultEntries,
  vaultGet,
  vaultList,
  vaultPut,
  vaultRemove
} from "../missions/vault-store";

interface CliIo {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
}

async function readStdinBuffer(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function attachVaultCommands(program: Command, cwd: string, io: CliIo): void {
  const vault = program.command("vault").description("Encrypted per-mission secret vault (Phase 15d).");

  vault
    .command("init")
    .description(`Create workspace KDF salt file (${VAULT_KDF_SALT_FILE_NAME}) if missing.`)
    .action(async () => {
      const paths = resolveWorkspacePaths(cwd);
      await ensureVaultKdfSaltBytes(paths.workspaceDir);
      io.writeOut(`Vault KDF salt ready at ${path.join(paths.workspaceDir, VAULT_KDF_SALT_FILE_NAME)}\n`);
    });

  vault
    .command("put")
    .description("Encrypt a secret into the mission vault.")
    .argument("<missionId>", "Mission id, e.g. m_abcd1234")
    .argument("<name>", "Entry name (1–64 chars: letters, digits, _ . -)")
    .option("--file <path>", "Read plaintext from this file (otherwise stdin)")
    .action(async (missionId: string, name: string, opts: { file?: string }) => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        let plaintext: Buffer;
        if (opts.file) {
          plaintext = await readFile(path.resolve(cwd, opts.file));
        } else {
          plaintext = await readStdinBuffer();
        }
        if (plaintext.length === 0) {
          io.writeErr("vault put: empty input; provide --file or pipe bytes on stdin.\n");
          process.exitCode = 1;
          return;
        }
        const pass = await resolveVaultPassphrase("Vault passphrase (encrypt)");
        await ensureVaultKdfSaltBytes(paths.workspaceDir);
        await vaultPut({
          missionsDir: paths.missionsDir,
          workspaceDir: paths.workspaceDir,
          missionId,
          name,
          plaintext,
          passphrase: pass
        });
        plaintext.fill(0);
        io.writeOut(`Stored vault entry "${name}" for ${missionId}\n`);
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "vault put failed"}\n`);
        process.exitCode = 1;
      }
    });

  vault
    .command("get")
    .description("Decrypt a vault entry to stdout.")
    .argument("<missionId>", "Mission id")
    .argument("<name>", "Entry name")
    .action(async (missionId: string, name: string) => {
      try {
        if (process.stdout.isTTY) {
          io.writeErr(
            "Warning: decrypting to a terminal may expose secrets in scrollback. Prefer piping to a file.\n"
          );
        }
        const paths = resolveWorkspacePaths(cwd);
        const pass = await resolveVaultPassphrase("Vault passphrase (decrypt)");
        const buf = await vaultGet({
          missionsDir: paths.missionsDir,
          workspaceDir: paths.workspaceDir,
          missionId,
          name,
          passphrase: pass
        });
        process.stdout.write(buf);
        buf.fill(0);
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "vault get failed"}\n`);
        process.exitCode = 1;
      }
    });

  vault
    .command("list")
    .description("List vault entry names and metadata (no secrets).")
    .argument("<missionId>", "Mission id")
    .action(async (missionId: string) => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const entries = await vaultList(paths.missionsDir, missionId);
        if (entries.length === 0) {
          io.writeOut("(no vault entries)\n");
          return;
        }
        for (const e of entries) {
          io.writeOut(`${e.name}\tupdated=${e.updatedAt}\tsize=${e.size} bytes\t${e.alg}\n`);
        }
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "vault list failed"}\n`);
        process.exitCode = 1;
      }
    });

  vault
    .command("rm")
    .description("Remove a vault entry.")
    .argument("<missionId>", "Mission id")
    .argument("<name>", "Entry name")
    .action(async (missionId: string, name: string) => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        await vaultRemove({ missionsDir: paths.missionsDir, missionId, name });
        io.writeOut(`Removed vault entry "${name}"\n`);
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "vault rm failed"}\n`);
        process.exitCode = 1;
      }
    });

  vault
    .command("rekey")
    .description("Decrypt and re-encrypt all vault entries with a new passphrase.")
    .action(async () => {
      try {
        const paths = resolveWorkspacePaths(cwd);
        const oldPass = await resolveVaultPassphrase("Current vault passphrase");
        const { createInterface } = await import("node:readline/promises");
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          io.writeErr("vault rekey requires an interactive TTY for the new passphrase.\n");
          process.exitCode = 1;
          return;
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        let newPass: string;
        let again: string;
        try {
          newPass = (await rl.question("New vault passphrase: ")).trimEnd();
          again = (await rl.question("Repeat new passphrase: ")).trimEnd();
        } finally {
          rl.close();
        }
        if (newPass.length < 8) {
          io.writeErr("New passphrase must be at least 8 characters.\n");
          process.exitCode = 1;
          return;
        }
        if (newPass !== again) {
          io.writeErr("Passphrases do not match.\n");
          process.exitCode = 1;
          return;
        }
        const { entries } = await rekeyAllVaultEntries({
          missionsDir: paths.missionsDir,
          workspaceDir: paths.workspaceDir,
          oldPassphrase: oldPass,
          newPassphrase: newPass
        });
        io.writeOut(`Rekeyed ${entries} vault entr${entries === 1 ? "y" : "ies"}.\n`);
      } catch (error) {
        io.writeErr(`${error instanceof Error ? error.message : "vault rekey failed"}\n`);
        process.exitCode = 1;
      }
    });
}
