import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve directory containing built SPA (index.html). Works for dist bundle and tsx dev. */
export function resolveCockpitStaticRoot(entryImportMetaUrl: string): string {
  const entryDir = path.dirname(fileURLToPath(entryImportMetaUrl));
  const fromBundle = path.join(entryDir, "cockpit");
  if (existsSync(path.join(fromBundle, "index.html"))) {
    return path.resolve(fromBundle);
  }

  const repoRoot = path.resolve(entryDir, "..", "..");
  const built = path.join(repoRoot, "dist", "cockpit");
  if (existsSync(path.join(built, "index.html"))) {
    return path.resolve(built);
  }

  return path.resolve(fromBundle);
}
