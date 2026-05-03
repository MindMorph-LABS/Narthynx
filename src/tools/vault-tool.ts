import { z } from "zod";

import { resolveWorkspacePaths } from "../config/workspace";
import { vaultPassphraseEnvName } from "../missions/vault-passphrase";
import { vaultGet } from "../missions/vault-store";
import type { ToolAction } from "./types";

const vaultReadInputSchema = z.object({
  missionId: z.string().regex(/^m_[a-z0-9_-]+$/),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  encoding: z.enum(["utf8", "base64"]).default("utf8")
});

const vaultReadOutputSchema = z.object({
  missionId: z.string(),
  name: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  /** Decoded secret — treat as sensitive; avoid logging. */
  value: z.string()
});

export const vaultReadTool: ToolAction<z.infer<typeof vaultReadInputSchema>, z.infer<typeof vaultReadOutputSchema>> = {
  name: "vault.read",
  description:
    "Read a decrypted value from the mission encrypted vault (requires passphrase in NARTHYNX_VAULT_PASSPHRASE and vault policy).",
  inputSchema: vaultReadInputSchema,
  outputSchema: vaultReadOutputSchema,
  riskLevel: "high",
  sideEffect: "vault",
  requiresApproval: false,
  reversible: true,
  async run(input, context) {
    const parsed = vaultReadInputSchema.parse(input);
    const pass = process.env[vaultPassphraseEnvName()]?.trim();
    if (!pass) {
      throw new Error(`${vaultPassphraseEnvName()} must be set to use vault.read from the tool runner.`);
    }
    const paths = resolveWorkspacePaths(context.cwd);
    const buf = await vaultGet({
      missionsDir: paths.missionsDir,
      workspaceDir: paths.workspaceDir,
      missionId: parsed.missionId,
      name: parsed.name,
      passphrase: pass
    });
    const value = parsed.encoding === "base64" ? buf.toString("base64") : buf.toString("utf8");
    buf.fill(0);
    return {
      missionId: parsed.missionId,
      name: parsed.name,
      encoding: parsed.encoding,
      value
    };
  }
};
