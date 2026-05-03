import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { VAULT_KDF_SALT_FILE_NAME } from "../config/defaults";
import { missionDirectory } from "./store";
import { openVaultPayload, sealVaultPayload, VaultCryptoError, vaultEntryNameSchema, vaultEntryStorageFileName } from "./vault-crypto";

export const VAULT_DIR = "vault";
export const VAULT_ENTRIES_DIR = "entries";
export const VAULT_MANIFEST = "manifest.json";

export const vaultManifestEntrySchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  size: z.number().int().nonnegative(),
  alg: z.literal("aes-256-gcm+nxc-v1"),
  storageFile: z.string().min(1)
});

export const vaultManifestSchema = z.object({
  version: z.literal(1),
  entries: z.array(vaultManifestEntrySchema)
});

export type VaultManifest = z.infer<typeof vaultManifestSchema>;
export type VaultManifestEntry = z.infer<typeof vaultManifestEntrySchema>;

export async function ensureVaultKdfSaltBytes(workspaceDir: string): Promise<Buffer> {
  const saltPath = path.join(workspaceDir, VAULT_KDF_SALT_FILE_NAME);
  try {
    const raw = (await readFile(saltPath, "utf8")).trim();
    const buf = Buffer.from(raw, "hex");
    if (buf.length !== 32) {
      throw new Error("vault KDF salt file must contain 64 hex chars (32 bytes).");
    }
    return buf;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code !== "ENOENT") {
      throw error;
    }
    const fresh = randomBytes(32);
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(saltPath, `${fresh.toString("hex")}\n`, "utf8");
    return fresh;
  }
}

export async function loadVaultKdfSaltBytes(workspaceDir: string): Promise<Buffer> {
  const saltPath = path.join(workspaceDir, VAULT_KDF_SALT_FILE_NAME);
  const raw = (await readFile(saltPath, "utf8")).trim();
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    throw new Error("vault KDF salt file must contain 64 hex chars (32 bytes).");
  }
  return buf;
}

export function vaultRootForMission(missionsDir: string, missionId: string): string {
  return path.join(missionDirectory(missionsDir, missionId), VAULT_DIR);
}

export function vaultManifestPath(missionsDir: string, missionId: string): string {
  return path.join(vaultRootForMission(missionsDir, missionId), VAULT_MANIFEST);
}

export function vaultEntryPath(missionsDir: string, missionId: string, storageFile: string): string {
  return path.join(vaultRootForMission(missionsDir, missionId), VAULT_ENTRIES_DIR, path.basename(storageFile));
}

export async function readVaultManifest(missionsDir: string, missionId: string): Promise<VaultManifest> {
  const p = vaultManifestPath(missionsDir, missionId);
  const raw = await readFile(p, "utf8");
  const parsed = vaultManifestSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    throw new Error(`Invalid vault manifest: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function writeVaultManifestAtomic(missionsDir: string, missionId: string, manifest: VaultManifest): Promise<void> {
  const dir = vaultRootForMission(missionsDir, missionId);
  const p = vaultManifestPath(missionsDir, missionId);
  const parsed = vaultManifestSchema.parse(manifest);
  const body = `${JSON.stringify(parsed, null, 2)}\n`;
  const tmp = `${p}.${Date.now()}.tmp`;
  await mkdir(path.join(dir, VAULT_ENTRIES_DIR), { recursive: true });
  await writeFile(tmp, body, "utf8");
  await rename(tmp, p);
}

export async function vaultPut(options: {
  missionsDir: string;
  workspaceDir: string;
  missionId: string;
  name: string;
  plaintext: Buffer;
  passphrase: string;
}): Promise<void> {
  vaultEntryNameSchema.parse(options.name);
  const wsSalt = await ensureVaultKdfSaltBytes(options.workspaceDir);
  const storageFile = vaultEntryStorageFileName(options.missionId, options.name);
  const blob = sealVaultPayload({
    plaintext: options.plaintext,
    passphrase: options.passphrase,
    workspaceSalt: wsSalt,
    missionId: options.missionId,
    entryName: options.name
  });

  const root = vaultRootForMission(options.missionsDir, options.missionId);
  await mkdir(path.join(root, VAULT_ENTRIES_DIR), { recursive: true });

  const entryFile = vaultEntryPath(options.missionsDir, options.missionId, storageFile);
  const tmp = `${entryFile}.${Date.now()}.tmp`;
  await writeFile(tmp, blob);
  await rename(tmp, entryFile);

  let manifest: VaultManifest;
  try {
    manifest = await readVaultManifest(options.missionsDir, options.missionId);
  } catch {
    manifest = { version: 1, entries: [] };
  }
  const now = new Date().toISOString();
  const nextEntries = manifest.entries.filter((e) => e.name !== options.name);
  nextEntries.push({
    name: options.name,
    createdAt: manifest.entries.find((e) => e.name === options.name)?.createdAt ?? now,
    updatedAt: now,
    size: options.plaintext.length,
    alg: "aes-256-gcm+nxc-v1",
    storageFile
  });
  await writeVaultManifestAtomic(options.missionsDir, options.missionId, { version: 1, entries: nextEntries });
}

export async function vaultGet(options: {
  missionsDir: string;
  workspaceDir: string;
  missionId: string;
  name: string;
  passphrase: string;
}): Promise<Buffer> {
  vaultEntryNameSchema.parse(options.name);
  const manifest = await readVaultManifest(options.missionsDir, options.missionId);
  const entry = manifest.entries.find((e) => e.name === options.name);
  if (!entry) {
    throw new Error(`Vault entry not found: ${options.name}`);
  }
  const wsSalt = await loadVaultKdfSaltBytes(options.workspaceDir);
  const p = vaultEntryPath(options.missionsDir, options.missionId, entry.storageFile);
  const blob = await readFile(p);
  return openVaultPayload({
    blob,
    passphrase: options.passphrase,
    workspaceSalt: wsSalt,
    missionId: options.missionId,
    entryName: options.name
  });
}

export async function vaultList(missionsDir: string, missionId: string): Promise<VaultManifestEntry[]> {
  try {
    const m = await readVaultManifest(missionsDir, missionId);
    return [...m.entries].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function vaultRemove(options: {
  missionsDir: string;
  missionId: string;
  name: string;
}): Promise<void> {
  vaultEntryNameSchema.parse(options.name);
  const manifest = await readVaultManifest(options.missionsDir, options.missionId);
  const entry = manifest.entries.find((e) => e.name === options.name);
  if (!entry) {
    throw new Error(`Vault entry not found: ${options.name}`);
  }
  const filePath = vaultEntryPath(options.missionsDir, options.missionId, entry.storageFile);
  await rm(filePath, { force: true });
  const next = manifest.entries.filter((e) => e.name !== options.name);
  await writeVaultManifestAtomic(options.missionsDir, options.missionId, { version: 1, entries: next });
}

export interface VaultLocation {
  missionId: string;
  entryName: string;
  storagePath: string;
}

/** Enumerate all vault entry storage paths under missions dir. */
export async function listAllVaultStoragePaths(missionsDir: string): Promise<VaultLocation[]> {
  const out: VaultLocation[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(missionsDir);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const missionId = dir;
    if (!/^m_[a-z0-9_-]+$/.test(missionId)) {
      continue;
    }
    let manifest: VaultManifest;
    try {
      manifest = await readVaultManifest(missionsDir, missionId);
    } catch {
      continue;
    }
    for (const e of manifest.entries) {
      out.push({
        missionId,
        entryName: e.name,
        storagePath: vaultEntryPath(missionsDir, missionId, e.storageFile)
      });
    }
  }
  return out;
}

export async function rekeyAllVaultEntries(options: {
  missionsDir: string;
  workspaceDir: string;
  oldPassphrase: string;
  newPassphrase: string;
}): Promise<{ entries: number }> {
  const wsSalt = await loadVaultKdfSaltBytes(options.workspaceDir);
  const locations = await listAllVaultStoragePaths(options.missionsDir);
  let count = 0;
  for (const loc of locations) {
    const blob = await readFile(loc.storagePath);
    let plain: Buffer;
    try {
      plain = openVaultPayload({
        blob,
        passphrase: options.oldPassphrase,
        workspaceSalt: wsSalt,
        missionId: loc.missionId,
        entryName: loc.entryName
      });
    } catch (error) {
      const label = error instanceof VaultCryptoError ? error.message : "rekey failed";
      throw new Error(`${label} (${loc.missionId} / ${loc.entryName})`);
    }
    const newBlob = sealVaultPayload({
      plaintext: plain,
      passphrase: options.newPassphrase,
      workspaceSalt: wsSalt,
      missionId: loc.missionId,
      entryName: loc.entryName
    });
    plain.fill(0);
    const tmp = `${loc.storagePath}.${Date.now()}.rekey.tmp`;
    await writeFile(tmp, newBlob);
    await rename(tmp, loc.storagePath);
    count++;
  }
  return { entries: count };
}

/** Mission has a vault manifest on disk (entries may be empty). */
export async function missionHasVaultDir(missionsDir: string, missionId: string): Promise<boolean> {
  try {
    const s = await stat(vaultManifestPath(missionsDir, missionId));
    return s.isFile();
  } catch {
    return false;
  }
}

export { anyMissionUsesVault } from "./vault-scan";
