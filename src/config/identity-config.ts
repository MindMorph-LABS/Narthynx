import { readFile } from "node:fs/promises";

import YAML from "yaml";
import { z } from "zod";

import type { LedgerActorRef } from "../missions/ledger";

export const IDENTITY_FILE_NAME = "identity.yaml";

export const workspaceIdentitySchema = z.object({
  version: z.literal(1),
  actor_id: z.string().min(1).max(256),
  display_name: z.string().min(1).max(256).optional()
});

export type WorkspaceIdentityFile = z.infer<typeof workspaceIdentitySchema>;

export interface IdentityLoadFailure {
  ok: false;
  path: string;
  message: string;
}

export interface IdentityLoadSuccess {
  ok: true;
  path: string;
  value: WorkspaceIdentityFile;
}

export type IdentityLoadResult = IdentityLoadSuccess | IdentityLoadFailure;

export async function loadWorkspaceIdentityFile(filePath: string): Promise<IdentityLoadResult> {
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return { ok: false, path: filePath, message: "ENOENT" };
    }
    const message = error instanceof Error ? error.message : "Unknown read failure";
    return { ok: false, path: filePath, message };
  }

  let parsedJson: unknown;
  try {
    parsedJson = YAML.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid YAML";
    return { ok: false, path: filePath, message: `YAML parse error: ${message}` };
  }

  const parsed = workspaceIdentitySchema.safeParse(parsedJson);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    return { ok: false, path: filePath, message };
  }

  return { ok: true, path: filePath, value: parsed.data };
}

/**
 * Actor for ledger attribution: optional `.narthynx/identity.yaml` or
 * `NARTHYNX_ACTOR_ID` (+ optional `NARTHYNX_ACTOR_DISPLAY_NAME`).
 */
export async function resolveWorkspaceActor(identityFilePath: string): Promise<LedgerActorRef | undefined> {
  const fromEnvId = process.env.NARTHYNX_ACTOR_ID?.trim();
  const fromEnvName = process.env.NARTHYNX_ACTOR_DISPLAY_NAME?.trim();

  const loaded = await loadWorkspaceIdentityFile(identityFilePath);
  if (loaded.ok) {
    return {
      id: loaded.value.actor_id,
      displayName: loaded.value.display_name
    };
  }

  if (loaded.message === "ENOENT") {
    if (fromEnvId && fromEnvId.length > 0) {
      return {
        id: fromEnvId,
        ...(fromEnvName && fromEnvName.length > 0 ? { displayName: fromEnvName } : {})
      };
    }
    return undefined;
  }

  throw new Error(`identity.yaml invalid: ${loaded.message}`);
}
