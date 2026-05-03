import dagre from "dagre";

import type { PlanGraph } from "./graph";

/** Node box size used by Dagre and the cockpit (approximate card size). */
export const GRAPH_LAYOUT_NODE_WIDTH = 280;
export const GRAPH_LAYOUT_NODE_HEIGHT = 96;

export interface GraphLayoutSpacing {
  ranksep: number;
  nodesep: number;
  marginx: number;
  marginy: number;
}

const DEFAULT_SPACING: GraphLayoutSpacing = {
  ranksep: 72,
  nodesep: 52,
  marginx: 32,
  marginy: 32
};

/**
 * Layered DAG layout (rankdir TB). Returns top-left coordinates for React Flow
 * (Dagre returns node centers).
 */
export function computeDagrePositions(
  graph: PlanGraph,
  spacing: GraphLayoutSpacing = DEFAULT_SPACING
): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph({ compound: true });
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    nodesep: spacing.nodesep,
    ranksep: spacing.ranksep,
    marginx: spacing.marginx,
    marginy: spacing.marginy
  });

  for (const n of graph.nodes) {
    g.setNode(n.id, { width: GRAPH_LAYOUT_NODE_WIDTH, height: GRAPH_LAYOUT_NODE_HEIGHT });
  }

  for (const e of graph.edges) {
    if (g.hasNode(e.from) && g.hasNode(e.to)) {
      g.setEdge(e.from, e.to);
    }
  }

  dagre.layout(g);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of graph.nodes) {
    const withPos = g.node(n.id);
    if (withPos && typeof withPos.x === "number" && typeof withPos.y === "number") {
      positions[n.id] = {
        x: withPos.x - GRAPH_LAYOUT_NODE_WIDTH / 2,
        y: withPos.y - GRAPH_LAYOUT_NODE_HEIGHT / 2
      };
    } else {
      positions[n.id] = { x: 0, y: 0 };
    }
  }

  return positions;
}
