import { builtinTools } from "./builtin";
import type { ToolAction } from "./types";

export interface ToolRegistry {
  list(): ToolAction<unknown, unknown>[];
  get(name: string): ToolAction<unknown, unknown>;
  has(name: string): boolean;
}

export function createToolRegistry(tools: ToolAction<unknown, unknown>[] = builtinTools): ToolRegistry {
  const byName = new Map<string, ToolAction<unknown, unknown>>();

  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`Duplicate tool registered: ${tool.name}`);
    }
    byName.set(tool.name, tool);
  }

  return {
    list() {
      return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
    },

    get(name) {
      const tool = byName.get(name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      return tool;
    },

    has(name) {
      return byName.has(name);
    }
  };
}
