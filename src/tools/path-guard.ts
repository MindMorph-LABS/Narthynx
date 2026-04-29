import path from "node:path";

import type { WorkspacePolicy } from "../config/load";

export interface GuardedPath {
  absolutePath: string;
  relativePath: string;
}

export function resolveGuardedWorkspacePath(rootDir: string, requestedPath: string, policy: WorkspacePolicy): GuardedPath {
  const value = requestedPath.trim().length > 0 ? requestedPath.trim() : ".";
  const absolutePath = path.resolve(rootDir, value);
  const relativePath = path.relative(rootDir, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path is outside the workspace: ${requestedPath}`);
  }

  const displayPath = relativePath.length === 0 ? "." : normalizePath(relativePath);
  if (isDeniedPath(displayPath, policy.filesystem.deny)) {
    throw new Error(`Path is blocked by policy deny patterns: ${requestedPath}`);
  }

  return {
    absolutePath,
    relativePath: displayPath
  };
}

function isDeniedPath(relativePath: string, denyPatterns: string[]): boolean {
  const normalized = normalizePath(relativePath).toLowerCase();
  const basename = path.posix.basename(normalized);

  return denyPatterns.some((pattern) => {
    const rule = normalizePath(pattern).toLowerCase();

    if (rule === normalized || rule === basename) {
      return true;
    }

    if (rule.endsWith("/**")) {
      const prefix = rule.slice(0, -3);
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }

    if (rule.startsWith("**/*")) {
      return normalized.includes(rule.slice(4).replaceAll("*", ""));
    }

    if (rule.startsWith("*") && rule.endsWith("*")) {
      return normalized.includes(rule.slice(1, -1));
    }

    if (rule.startsWith("*")) {
      return basename.endsWith(rule.slice(1));
    }

    if (rule.endsWith("*")) {
      return basename.startsWith(rule.slice(0, -1));
    }

    return false;
  });
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}
