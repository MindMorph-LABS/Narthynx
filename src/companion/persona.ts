import { mkdir, readFile, writeFile } from "node:fs/promises";

import YAML from "yaml";

import type { WorkspacePaths } from "../config/workspace";
import { personaFileSchema, type PersonaFile } from "./models";
import { ensureCompanionDirs } from "./store";

export const DEFAULT_PERSONA: PersonaFile = {
  version: 1,
  name: "Narthynx Companion",
  tone: "Brief, pragmatic, respectful. Help the user organize work and propose missions explicitly.",
  safety_appendix:
    "Do not claim consciousness or manipulate emotions. For medical, legal, or high-stakes financial topics, defer to licensed professionals rather than prescribing actions."
};

export async function loadPersonaOrDefault(paths: WorkspacePaths): Promise<PersonaFile> {
  await ensureCompanionDirs(paths);
  let raw = "";
  try {
    raw = await readFile(paths.companionPersonaFile, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      await writeDefaultPersonaFile(paths);
      return DEFAULT_PERSONA;
    }
    throw e;
  }
  const parsed = YAML.parse(raw);
  const result = personaFileSchema.safeParse(parsed);
  if (!result.success) {
    return DEFAULT_PERSONA;
  }
  return result.data;
}

export async function writeDefaultPersonaFile(paths: WorkspacePaths): Promise<void> {
  await ensureCompanionDirs(paths);
  await writeFile(paths.companionPersonaFile, `${YAML.stringify(DEFAULT_PERSONA)}\n`, "utf8");
}

export async function ensurePersonaFileExists(paths: WorkspacePaths): Promise<void> {
  await mkdir(paths.companionDir, { recursive: true });
  try {
    await readFile(paths.companionPersonaFile, "utf8");
  } catch {
    await writeDefaultPersonaFile(paths);
  }
}
