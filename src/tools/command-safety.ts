import path from "node:path";

export interface CommandSafetyInput {
  command: string;
  args: string[];
}

export interface CommandSafetyResult {
  ok: boolean;
  reason?: string;
}

const SHELL_METACHARACTER_PATTERN = /(\$\(|[|;&<>`])/;

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[^\s]*r[^\s]*f|\brm\s+-[^\s]*f[^\s]*r/i, reason: "Recursive force deletion is blocked." },
  { pattern: /\bdel\s+\/s\b/i, reason: "Recursive Windows deletion is blocked." },
  { pattern: /\bformat\b/i, reason: "Disk formatting commands are blocked." },
  { pattern: /\bshutdown\b/i, reason: "Shutdown commands are blocked." },
  { pattern: /\bcurl\b.*\bsh\b/i, reason: "Piping downloaded scripts into shell is blocked." },
  { pattern: /\binvoke-webrequest\b.*\biex\b/i, reason: "Invoke-WebRequest piped into expression execution is blocked." },
  { pattern: /\biwr\b.*\biex\b/i, reason: "iwr piped into expression execution is blocked." },
  { pattern: /^\s*sudo\b/i, reason: "Privilege escalation through sudo is blocked." },
  { pattern: /\bchmod\s+-r\s+777\b/i, reason: "Recursive chmod 777 is blocked." }
];

export function classifyCommandSafety(input: CommandSafetyInput): CommandSafetyResult {
  const commandAndArgs = [input.command, ...input.args];

  for (const value of commandAndArgs) {
    if (SHELL_METACHARACTER_PATTERN.test(value)) {
      return {
        ok: false,
        reason: `Shell metacharacters are blocked in Phase 11 shell.run: ${value}`
      };
    }

    if (value.includes("\n") || value.includes("\r")) {
      return {
        ok: false,
        reason: "Newlines are blocked in Phase 11 shell.run arguments."
      };
    }
  }

  const joined = commandAndArgs.join(" ");
  for (const blocked of BLOCKED_PATTERNS) {
    if (blocked.pattern.test(joined)) {
      return {
        ok: false,
        reason: blocked.reason
      };
    }
  }

  return { ok: true };
}

export function classifyShellRunInputSafety(input: unknown, rootDir: string): CommandSafetyResult {
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      reason: "shell.run input must be an object."
    };
  }

  const value = input as { command?: unknown; args?: unknown; cwd?: unknown };
  if (typeof value.command !== "string") {
    return {
      ok: false,
      reason: "shell.run command must be a string."
    };
  }

  const args = Array.isArray(value.args) ? value.args : [];
  if (!args.every((arg) => typeof arg === "string")) {
    return {
      ok: false,
      reason: "shell.run args must be strings."
    };
  }

  try {
    resolveWorkspaceCommandCwd(rootDir, typeof value.cwd === "string" ? value.cwd : ".");
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Invalid shell.run cwd."
    };
  }

  return classifyCommandSafety({
    command: value.command,
    args
  });
}

export function shellRunApprovalTarget(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const value = input as { command?: unknown; args?: unknown; cwd?: unknown };
  if (typeof value.command !== "string") {
    return undefined;
  }

  const args = Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string") ? value.args : [];
  const cwd = typeof value.cwd === "string" ? value.cwd : ".";
  return `${value.command}${args.length > 0 ? ` ${args.join(" ")}` : ""} (cwd: ${cwd})`;
}

export function resolveWorkspaceCommandCwd(rootDir: string, requestedCwd = "."): { absolutePath: string; relativePath: string } {
  const absolutePath = path.resolve(rootDir, requestedCwd);
  const relativeFromRoot = path.relative(rootDir, absolutePath);

  if (relativeFromRoot === "" || (!relativeFromRoot.startsWith("..") && !path.isAbsolute(relativeFromRoot))) {
    return {
      absolutePath,
      relativePath: relativeFromRoot === "" ? "." : normalizePath(relativeFromRoot)
    };
  }

  throw new Error(`Command cwd is outside the workspace: ${requestedCwd}`);
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}
