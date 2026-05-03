import path from "node:path";

import { z } from "zod";

export const GRAPH_VIEW_FILE_NAME = "graph-view.json";

export const graphViewFileSchema = z.object({
  version: z.literal(1),
  positions: z.record(
    z.string().min(1),
    z.object({
      x: z.number(),
      y: z.number()
    })
  )
});

export type GraphViewFile = z.infer<typeof graphViewFileSchema>;

export function graphViewFilePath(missionDir: string): string {
  return path.join(missionDir, GRAPH_VIEW_FILE_NAME);
}
