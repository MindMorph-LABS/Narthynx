import { tokenizeSlashRest } from "./tokenize";

export interface ShellShortcutInput {
  command: string;
  args: string[];
}

export function parseShellShortcut(line: string): ShellShortcutInput {
  const trimmed = line.trim();
  if (!trimmed.startsWith("!")) {
    throw new Error("Shell shortcut must start with !.");
  }

  const tokens = tokenizeSlashRest(trimmed.slice(1).trim());
  const [command, ...args] = tokens;
  if (!command) {
    throw new Error("Shell command is required after !.");
  }

  return { command, args };
}

export function parseAtShortcut(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("@")) {
    throw new Error("Context shortcut must start with @.");
  }

  const path = trimmed.slice(1).trim();
  if (!path) {
    throw new Error("File path is required after @.");
  }

  return path;
}

export function parseHashShortcut(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#")) {
    throw new Error("Note shortcut must start with #.");
  }

  const note = trimmed.slice(1).trim();
  if (!note) {
    throw new Error("Note text is required after #.");
  }

  return note;
}

/** Relative or display path segments to reject for @ context attach. */
export function isSensitiveContextPath(relativeOrDisplayPath: string): boolean {
  const normalized = relativeOrDisplayPath.replaceAll("\\", "/").trim();
  const lower = normalized.toLowerCase();
  const base = lower.split("/").pop() ?? lower;

  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }

  if (base === "id_rsa" || base === "id_rsa.pub" || base === "id_ed25519" || base === "id_ed25519.pub") {
    return true;
  }

  if (base === "known_hosts" || base === "authorized_keys") {
    return true;
  }

  if (base.endsWith(".pem") || base.endsWith(".key") || base.endsWith(".ppk")) {
    return true;
  }

  if (lower.includes("/.ssh/") || lower.startsWith(".ssh/")) {
    return true;
  }

  return false;
}
