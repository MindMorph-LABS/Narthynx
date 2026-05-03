import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";

import { z } from "zod";

/** On-disk missions vault ciphertext (`.nxc`). */
export const VAULT_MAGIC = Buffer.from("NXV1", "ascii");
export const VAULT_BLOB_VERSION = 1;
export const DEFAULT_SCRYPT_N = 2 ** 17; // 131072; maxmem ~132MB at r=8, p=1
export const AUTH_TAG_LENGTH = 16;

export class VaultCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultCryptoError";
  }
}

export function buildVaultAad(missionId: string, entryName: string): string {
  return `narthynx.missionVault/v1|${missionId}|${entryName}`;
}

export function deriveVaultAesKey(
  passphrase: string,
  workspaceSalt: Buffer,
  fileSalt: Buffer,
  N: number,
  r: number,
  p: number
): Buffer {
  const combinedSalt = Buffer.concat([workspaceSalt, fileSalt]);
  const ikm = scryptSync(passphrase, combinedSalt, 64, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024
  });
  const key = Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from("narthynx.missionVault/v1.aes", "utf8"), 32));
  ikm.fill(0);
  return key;
}

export interface SealOptions {
  plaintext: Buffer;
  passphrase: string;
  workspaceSalt: Buffer;
  missionId: string;
  entryName: string;
  /** Defaults to `DEFAULT_SCRYPT_N`. */
  scryptN?: number;
}

export function sealVaultPayload(options: SealOptions): Buffer {
  const N = options.scryptN ?? DEFAULT_SCRYPT_N;
  const r = 8;
  const p = 1;
  const fileSalt = randomBytes(32);
  const iv = randomBytes(12);
  const aadUtf8 = buildVaultAad(options.missionId, options.entryName);
  const aad = Buffer.from(aadUtf8, "utf8");
  const key = deriveVaultAesKey(options.passphrase, options.workspaceSalt, fileSalt, N, r, p);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_LENGTH });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(options.plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return encodeVaultBlob({
      version: VAULT_BLOB_VERSION,
      N,
      r,
      p,
      fileSalt,
      iv,
      aad,
      ciphertextAndTag: Buffer.concat([ciphertext, tag])
    });
  } finally {
    key.fill(0);
  }
}

export interface OpenOptions {
  blob: Buffer;
  passphrase: string;
  workspaceSalt: Buffer;
  missionId: string;
  entryName: string;
}

export function openVaultPayload(options: OpenOptions): Buffer {
  const parsed = parseVaultBlob(options.blob);
  const expectAad = Buffer.from(buildVaultAad(options.missionId, options.entryName), "utf8");
  if (parsed.aad.length !== expectAad.length || !timingSafeEqual(parsed.aad, expectAad)) {
    throw new VaultCryptoError("Vault entry AAD does not match mission or secret name.");
  }

  const key = deriveVaultAesKey(
    options.passphrase,
    options.workspaceSalt,
    parsed.fileSalt,
    parsed.N,
    parsed.r,
    parsed.p
  );
  try {
    const body = parsed.ciphertextAndTag;
    if (body.length < AUTH_TAG_LENGTH) {
      throw new VaultCryptoError("Vault ciphertext is truncated.");
    }
    const enc = body.subarray(0, body.length - AUTH_TAG_LENGTH);
    const tag = body.subarray(body.length - AUTH_TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAAD(parsed.aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch (error) {
    if (error instanceof VaultCryptoError) {
      throw error;
    }
    throw new VaultCryptoError("Vault decryption failed (wrong passphrase or corrupted data).");
  } finally {
    key.fill(0);
  }
}

function encodeVaultBlob(parts: {
  version: number;
  N: number;
  r: number;
  p: number;
  fileSalt: Buffer;
  iv: Buffer;
  aad: Buffer;
  ciphertextAndTag: Buffer;
}): Buffer {
  if (parts.version < 0 || parts.version > 255) {
    throw new VaultCryptoError("Invalid vault blob version.");
  }
  if (parts.fileSalt.length > 65535 || parts.iv.length > 65535) {
    throw new VaultCryptoError("Vault salt or IV length out of range.");
  }
  const headLen =
    VAULT_MAGIC.length +
    1 +
    4 +
    1 +
    1 +
    2 +
    parts.fileSalt.length +
    2 +
    parts.iv.length +
    4 +
    parts.aad.length +
    4;
  const head = Buffer.allocUnsafe(headLen);
  let o = 0;
  VAULT_MAGIC.copy(head, o);
  o += VAULT_MAGIC.length;
  head.writeUInt8(parts.version, o);
  o++;
  head.writeUInt32BE(parts.N, o);
  o += 4;
  head.writeUInt8(parts.r, o);
  o++;
  head.writeUInt8(parts.p, o);
  o++;
  head.writeUInt16BE(parts.fileSalt.length, o);
  o += 2;
  parts.fileSalt.copy(head, o);
  o += parts.fileSalt.length;
  head.writeUInt16BE(parts.iv.length, o);
  o += 2;
  parts.iv.copy(head, o);
  o += parts.iv.length;
  head.writeUInt32BE(parts.aad.length, o);
  o += 4;
  parts.aad.copy(head, o);
  o += parts.aad.length;
  head.writeUInt32BE(parts.ciphertextAndTag.length, o);
  o += 4;
  return Buffer.concat([head, parts.ciphertextAndTag]);
}

export interface ParsedVaultBlob {
  version: number;
  N: number;
  r: number;
  p: number;
  fileSalt: Buffer;
  iv: Buffer;
  aad: Buffer;
  ciphertextAndTag: Buffer;
}

export function parseVaultBlob(blob: Buffer): ParsedVaultBlob {
  let o = 0;
  if (blob.length < VAULT_MAGIC.length + 1 + 4 + 1 + 1 + 2 + 2 + 4 + 4) {
    throw new VaultCryptoError("Vault file is too small.");
  }
  const magic = blob.subarray(o, o + VAULT_MAGIC.length);
  o += VAULT_MAGIC.length;
  if (!timingSafeEqual(magic, VAULT_MAGIC)) {
    throw new VaultCryptoError("Unknown vault file magic.");
  }
  const version = blob.readUInt8(o);
  o++;
  if (version !== VAULT_BLOB_VERSION) {
    throw new VaultCryptoError(`Unsupported vault format version: ${version}.`);
  }
  const N = blob.readUInt32BE(o);
  o += 4;
  const r = blob.readUInt8(o);
  o++;
  const p = blob.readUInt8(o);
  o++;
  const saltLen = blob.readUInt16BE(o);
  o += 2;
  if (saltLen === 0 || o + saltLen > blob.length) {
    throw new VaultCryptoError("Invalid vault salt length.");
  }
  const fileSalt = blob.subarray(o, o + saltLen);
  o += saltLen;
  const ivLen = blob.readUInt16BE(o);
  o += 2;
  if (ivLen === 0 || o + ivLen > blob.length) {
    throw new VaultCryptoError("Invalid vault IV length.");
  }
  const iv = blob.subarray(o, o + ivLen);
  o += ivLen;
  const aadLen = blob.readUInt32BE(o);
  o += 4;
  if (aadLen > 4096 || o + aadLen > blob.length) {
    throw new VaultCryptoError("Invalid vault AAD length.");
  }
  const aad = blob.subarray(o, o + aadLen);
  o += aadLen;
  const ctLen = blob.readUInt32BE(o);
  o += 4;
  if (ctLen < AUTH_TAG_LENGTH || o + ctLen > blob.length) {
    throw new VaultCryptoError("Invalid vault ciphertext length.");
  }
  const ciphertextAndTag = blob.subarray(o, o + ctLen);
  o += ctLen;
  if (o !== blob.length) {
    throw new VaultCryptoError("Vault file has trailing data.");
  }
  return { version, N, r, p, fileSalt, iv, aad, ciphertextAndTag };
}

export const vaultEntryNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_.-]+$/);

export function vaultEntryStorageFileName(missionId: string, entryName: string): string {
  const hash = createHash("sha256").update(`${missionId}\0${entryName}`, "utf8").digest("hex");
  return `${hash}.nxc`;
}

export function fingerprintVaultEntry(missionId: string, entryName: string): string {
  return createHash("sha256").update(`${missionId}\0${entryName}`, "utf8").digest("hex").slice(0, 32);
}
