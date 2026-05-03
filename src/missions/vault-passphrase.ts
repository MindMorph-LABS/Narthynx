import { createInterface } from "node:readline/promises";

const ENV_PASS = "NARTHYNX_VAULT_PASSPHRASE";

/** Reads passphrase from env (trimmed) or interactive prompt on a TTY. */
export async function resolveVaultPassphrase(label = "Vault passphrase"): Promise<string> {
  const fromEnv = process.env[ENV_PASS]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${ENV_PASS} is not set and this process has no TTY. Set the env var non-interactively or run in a terminal.`
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pass = await rl.question(`${label} (may echo in this terminal): `);
    return pass.trimEnd();
  } finally {
    rl.close();
  }
}

export function vaultPassphraseEnvName(): typeof ENV_PASS {
  return ENV_PASS;
}
