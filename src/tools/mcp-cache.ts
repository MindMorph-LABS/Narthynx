import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE_TTL_MS = 5 * 60 * 1_000;

export interface McpToolsCacheEntry {
  serverId: string;
  cachedAt: string;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>;
}

function safeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpToolsCacheFile(cacheDir: string, serverId: string): string {
  return path.join(cacheDir, `${safeSegment(serverId)}.json`);
}

export async function readMcpToolsCache(cacheDir: string, serverId: string, maxAgeMs = CACHE_TTL_MS): Promise<McpToolsCacheEntry | undefined> {
  const file = mcpToolsCacheFile(cacheDir, serverId);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as McpToolsCacheEntry;
    const t = Date.parse(parsed.cachedAt);
    if (Number.isNaN(t) || Date.now() - t > maxAgeMs) {
      return undefined;
    }
    if (parsed.serverId !== serverId) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function cacheEntryFresh(entry: McpToolsCacheEntry | undefined, maxAgeMs = CACHE_TTL_MS): boolean {
  if (!entry) {
    return false;
  }
  const t = Date.parse(entry.cachedAt);
  if (Number.isNaN(t)) {
    return false;
  }
  return Date.now() - t <= maxAgeMs;
}

export async function writeMcpToolsCache(cacheDir: string, entry: McpToolsCacheEntry): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const file = mcpToolsCacheFile(cacheDir, entry.serverId);
  await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}
