import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspacePaths } from "../config/workspace";
import { createMissionStore } from "../missions/store";
import { approvedMemorySnippetForModel } from "../memory/user-memory";
import { loadPersonaOrDefault } from "./persona";

export interface DailyBriefingOptions {
  cwd: string;
  paths: WorkspacePaths;
  writeArtifact?: boolean;
}

export async function buildDailyBriefingText(options: DailyBriefingOptions): Promise<string> {
  const store = createMissionStore(options.cwd);
  const missions = (await store.listMissions()).slice(0, 50);
  const persona = await loadPersonaOrDefault(options.paths);
  const mem = await approvedMemorySnippetForModel(options.paths, { maxChars: 2_000 });

  const lines: string[] = [
    `Daily briefing — ${new Date().toISOString()}`,
    `Persona: ${persona.name}`,
    "",
    "Missions (recent):"
  ];

  for (const m of missions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 15)) {
    lines.push(`- ${m.id}  ${m.state}  ${m.title}`);
  }

  lines.push("", "Approved memory snippets:");
  lines.push(mem.length > 0 ? mem : "(none)");

  lines.push(
    "",
    "Next steps: pick a mission with /mission <id> or create a new one. Companion suggestions never auto-execute tools."
  );

  return lines.join("\n");
}

export async function writeDailyBriefingArtifact(options: DailyBriefingOptions): Promise<string> {
  const text = await buildDailyBriefingText(options);
  await mkdir(options.paths.companionArtifactsDir, { recursive: true });
  const name = `briefing-${new Date().toISOString().replaceAll(":", "-")}.md`;
  const out = path.join(options.paths.companionArtifactsDir, name);
  await writeFile(out, `${text}\n`, "utf8");
  return out;
}
