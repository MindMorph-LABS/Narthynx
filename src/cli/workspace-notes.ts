import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { resolveWorkspacePaths } from "../config/workspace";

export const WORKSPACE_NOTES_FILE = "workspace-notes.md";

/** Heuristic: note may contain credentials or private key material — warn before persisting. */
export function workspaceNoteLooksSensitive(text: string): boolean {
  const t = text.toLowerCase();
  if (/begin\s+(rsa|openssh|ec)\s+private\s+key/.test(t)) {
    return true;
  }
  if (/\b(api[_-]?key|apikey|secret|password|passwd|token|bearer|authorization)\s*[:=]/.test(t)) {
    return true;
  }
  if (/\b(ghp_|gho_|github_pat_|xox[baprs]-|sk-live-|sk_test_|AKIA[0-9A-Z]{16})\b/.test(text)) {
    return true;
  }
  return false;
}

export async function appendWorkspaceNote(cwd: string, note: string): Promise<string> {
  const paths = resolveWorkspacePaths(cwd);
  const filePath = path.join(paths.workspaceDir, WORKSPACE_NOTES_FILE);
  await mkdir(paths.workspaceDir, { recursive: true });
  const now = new Date().toISOString();
  const header = "# Workspace notes\n\n";
  let existing = "";

  try {
    existing = await readFile(filePath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code !== "ENOENT") {
      throw error;
    }
  }

  if (existing.length === 0) {
    existing = header;
  }

  const chunk = [`## Note - ${now}`, "", note.trim(), ""].join("\n");
  await appendFile(filePath, `${existing.endsWith("\n") ? "" : "\n"}${chunk}\n`, "utf8");
  return filePath;
}
