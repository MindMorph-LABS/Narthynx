# Encrypted mission vault (Phase 15d)

Narthynx stores durable missions as local files. **Secrets must not go into `mission.yaml`, the ledger, reports, or replay text.** The **encrypted per-mission vault** is the supported place for credentials and other sensitive blobs **at rest**.

## Layout

- **Workspace KDF salt:** `.narthynx/vault-kdf.salt` — 32 random bytes (hex-encoded). Created by `narthynx vault init` or on the first `vault put`. Binds passphrases to this workspace.
- **Per mission:** `.narthynx/missions/<mission-id>/vault/manifest.json` (metadata only, no plaintext secrets) and `vault/entries/*.nxc` (encrypted payloads).

## Cryptography (v1)

- **KDF:** `scrypt` (default **N = 2^17**, **r = 8**, **p = 1**) over `workspaceSalt || perFileSalt`, then **HKDF-SHA256** to a 32-byte AES key.
- **AEAD:** **AES-256-GCM** with **12-byte IV** and AAD string  
  `narthynx.missionVault/v1|<missionId>|<entryName>` so ciphertext cannot be swapped between missions or names.

## CLI

```bash
narthynx vault init
echo -n 'my-api-key' | narthynx vault put m_abc123 api_key
narthynx vault list m_abc123
narthynx vault get m_abc123 api_key   # prefer piping to a file; warns on TTY
narthynx vault rm m_abc123 api_key
narthynx vault rekey                 # interactive new passphrase
```

**Passphrase:** Interactive prompt in a terminal, or set **`NARTHYNX_VAULT_PASSPHRASE`** for automation. Never log or commit this variable.

## Policy and `vault.read`

Runtime access uses the typed tool **`vault.read`** (high risk). In **`policy.yaml`**:

- **`vault: block`** (default) — tool denied.
- **`vault: ask`** — requires approval; passphrase must still be in **`NARTHYNX_VAULT_PASSPHRASE`** for the tool runner.
- **`vault: allow`** — runs without approval when other policy checks pass (use only in trusted environments).

Successful reads append a ledger event **`vault.secret_read`** with a **redacted** `entryFingerprint` only — never the secret.

## Cockpit

The local web Cockpit does **not** expose vault APIs in v1. Do not serve secrets over the shared-bearer HTTP surface without a dedicated vault-unlock and auth design.

## Threat model

The vault protects **at-rest** files on disk from casual inspection and mistaken commits **given a strong passphrase**. It does **not** protect against malware on the machine, a compromised OS user, or pasting secrets into chat or mission notes.

See also [`safety-model.md`](safety-model.md) and [`SECURITY.md`](../SECURITY.md).
