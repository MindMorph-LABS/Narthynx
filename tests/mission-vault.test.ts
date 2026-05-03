import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { initWorkspace } from "../src/config/workspace";
import { createMissionStore } from "../src/missions/store";
import {
  DEFAULT_SCRYPT_N,
  buildVaultAad,
  fingerprintVaultEntry,
  openVaultPayload,
  parseVaultBlob,
  sealVaultPayload,
  VaultCryptoError
} from "../src/missions/vault-crypto";
import { anyMissionUsesVault } from "../src/missions/vault-scan";
import {
  ensureVaultKdfSaltBytes,
  rekeyAllVaultEntries,
  vaultGet,
  vaultList,
  vaultPut,
  vaultRemove
} from "../src/missions/vault-store";

const wsSalt = Buffer.alloc(32, 7);

describe("mission vault crypto", () => {
  it("roundtrips plaintext with bound AAD", () => {
    const plain = Buffer.from("secret-api-token", "utf8");
    const blob = sealVaultPayload({
      plaintext: plain,
      passphrase: "correct horse battery staple",
      workspaceSalt: wsSalt,
      missionId: "m_testvault",
      entryName: "api_key",
      scryptN: 4096
    });
    const out = openVaultPayload({
      blob,
      passphrase: "correct horse battery staple",
      workspaceSalt: wsSalt,
      missionId: "m_testvault",
      entryName: "api_key"
    });
    expect(out.equals(plain)).toBe(true);
  });

  it("fails on wrong passphrase", () => {
    const blob = sealVaultPayload({
      plaintext: Buffer.from("x"),
      passphrase: "one",
      workspaceSalt: wsSalt,
      missionId: "m_a",
      entryName: "k",
      scryptN: 4096
    });
    expect(() =>
      openVaultPayload({
        blob,
        passphrase: "two",
        workspaceSalt: wsSalt,
        missionId: "m_a",
        entryName: "k"
      })
    ).toThrow(VaultCryptoError);
  });

  it("fails AAD mismatch across entry names", () => {
    const blob = sealVaultPayload({
      plaintext: Buffer.from("x"),
      passphrase: "p",
      workspaceSalt: wsSalt,
      missionId: "m_a",
      entryName: "a",
      scryptN: 4096
    });
    expect(() =>
      openVaultPayload({
        blob,
        passphrase: "p",
        workspaceSalt: wsSalt,
        missionId: "m_a",
        entryName: "b"
      })
    ).toThrow(VaultCryptoError);
  });

  it("fails on tampered ciphertext", () => {
    const blob = sealVaultPayload({
      plaintext: Buffer.from("x"),
      passphrase: "p",
      workspaceSalt: wsSalt,
      missionId: "m_a",
      entryName: "k",
      scryptN: 4096
    });
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() =>
      openVaultPayload({
        blob: tampered,
        passphrase: "p",
        workspaceSalt: wsSalt,
        missionId: "m_a",
        entryName: "k"
      })
    ).toThrow(VaultCryptoError);
  });

  it("parse rejects bad magic", () => {
    const good = sealVaultPayload({
      plaintext: Buffer.from("x"),
      passphrase: "p",
      workspaceSalt: wsSalt,
      missionId: "m_a",
      entryName: "k",
      scryptN: 4096
    });
    const b = Buffer.from(good);
    b[0] ^= 0xff;
    expect(() => parseVaultBlob(b)).toThrow(VaultCryptoError);
  });

  it("fingerprint is stable", () => {
    expect(fingerprintVaultEntry("m_x", "k")).toMatch(/^[a-f0-9]{32}$/);
    expect(fingerprintVaultEntry("m_x", "k")).toBe(fingerprintVaultEntry("m_x", "k"));
  });

  it("documents default scrypt N for ops", () => {
    expect(DEFAULT_SCRYPT_N).toBe(131072);
    expect(buildVaultAad("m_1", "n")).toContain("m_1");
  });
});

describe("mission vault store", () => {
  it("put/list/get/remove and rekey", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "narthynx-vault-"));
    await initWorkspace(cwd);
    const store = createMissionStore(cwd);
    const m = await store.createMission({ goal: "vault test" });
    const paths = path.join(cwd, ".narthynx");
    const missionsDir = path.join(paths, "missions");

    await vaultPut({
      missionsDir,
      workspaceDir: paths,
      missionId: m.id,
      name: "token",
      plaintext: Buffer.from("hello-vault", "utf8"),
      passphrase: "first-pass-phrase!!"
    });

    expect(await anyMissionUsesVault(missionsDir)).toBe(true);

    const list = await vaultList(missionsDir, m.id);
    expect(list.map((e) => e.name)).toContain("token");

    const buf = await vaultGet({
      missionsDir,
      workspaceDir: paths,
      missionId: m.id,
      name: "token",
      passphrase: "first-pass-phrase!!"
    });
    expect(buf.toString("utf8")).toBe("hello-vault");
    buf.fill(0);

    await rekeyAllVaultEntries({
      missionsDir,
      workspaceDir: paths,
      oldPassphrase: "first-pass-phrase!!",
      newPassphrase: "second-pass-phrase!!"
    });

    const buf2 = await vaultGet({
      missionsDir,
      workspaceDir: paths,
      missionId: m.id,
      name: "token",
      passphrase: "second-pass-phrase!!"
    });
    expect(buf2.toString("utf8")).toBe("hello-vault");
    buf2.fill(0);

    await vaultRemove({ missionsDir, missionId: m.id, name: "token" });
    expect(await vaultList(missionsDir, m.id)).toEqual([]);

    await rm(cwd, { recursive: true, force: true });
  });

  it("ensureVaultKdfSaltBytes creates salt file", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "narthynx-vault-salt-"));
    await mkdir(path.join(cwd, ".narthynx"), { recursive: true });
    const wsDir = path.join(cwd, ".narthynx");
    const salt = await ensureVaultKdfSaltBytes(wsDir);
    expect(salt.length).toBe(32);
    const raw = await readFile(path.join(wsDir, "vault-kdf.salt"), "utf8");
    expect(raw.trim().length).toBe(64);
    await rm(cwd, { recursive: true, force: true });
  });
});
