import { readFile } from "node:fs/promises";

import YAML from "yaml";

import type { WorkspacePaths } from "../config/workspace";
import { triggersFileSchema, type TriggersConfig } from "./schema";
import { triggersRulesPath } from "./paths";

export async function loadTriggersConfig(paths: WorkspacePaths): Promise<{ ok: true; config: TriggersConfig } | { ok: false; message: string }> {
  const fp = triggersRulesPath(paths);
  let raw: string;
  try {
    raw = await readFile(fp, "utf8");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String(e.code) : "";
    if (code === "ENOENT") {
      return { ok: false, message: `triggers.yaml not found at ${fp}. Create one to use event-to-mission triggers.` };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Failed to read triggers.yaml" };
  }

  try {
    const parsed = YAML.parse(raw);
    const result = triggersFileSchema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        message: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      };
    }
    return { ok: true, config: result.data };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Invalid YAML in triggers.yaml" };
  }
}

export function validateTriggersYamlText(raw: string): { ok: true; config: TriggersConfig } | { ok: false; message: string } {
  try {
    const parsed = YAML.parse(raw);
    const result = triggersFileSchema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        message: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      };
    }
    return { ok: true, config: result.data };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Invalid YAML" };
  }
}
