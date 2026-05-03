import type { PlanGraph } from "../missions/graph";
import { computeDagrePositions } from "../missions/graph-layout";
import {
  buildGraphExecutionOverlay,
  type GraphExecutionOverlay,
  shouldHighlightEdge
} from "../missions/graph-view";
import type { LedgerEvent } from "../missions/ledger";

export interface FlowNodeDto {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    nodeType: string;
    status: string;
    description: string;
    /** True if node is completed, failed, or on the current execution frontier. */
    emphasis: boolean;
  };
}

export interface FlowEdgeDto {
  id: string;
  source: string;
  target: string;
  animated: boolean;
  highlighted: boolean;
  edgeType: "smoothstep";
}

export interface MissionGraphViewDto {
  nodes: FlowNodeDto[];
  edges: FlowEdgeDto[];
  overlay: GraphExecutionOverlay;
}

function mergeWithSavedPositions(
  auto: Record<string, { x: number; y: number }>,
  saved: Record<string, { x: number; y: number }> | null | undefined,
  validNodeIds: Set<string>
): Record<string, { x: number; y: number }> {
  const out = { ...auto };
  if (!saved) {
    return out;
  }
  for (const [id, pos] of Object.entries(saved)) {
    if (!validNodeIds.has(id) || pos === undefined) {
      continue;
    }
    if (typeof pos.x === "number" && typeof pos.y === "number") {
      out[id] = { x: pos.x, y: pos.y };
    }
  }
  return out;
}

/**
 * Full graph view for cockpit/API: Dagre layout, optional saved positions, execution overlay, edge highlights.
 */
export function buildMissionGraphViewDto(
  graph: PlanGraph,
  ledgerEvents: LedgerEvent[],
  options?: {
    savedPositions?: Record<string, { x: number; y: number }> | null;
  }
): MissionGraphViewDto {
  const autoPos = computeDagrePositions(graph);
  const validIds = new Set(graph.nodes.map((n) => n.id));
  const positions = mergeWithSavedPositions(autoPos, options?.savedPositions, validIds);
  const overlay = buildGraphExecutionOverlay(graph, ledgerEvents);
  const frontierSet = new Set(overlay.frontierNodeIds);

  const nodes: FlowNodeDto[] = graph.nodes.map((node) => {
    const emphasis =
      node.status === "completed" ||
      node.status === "failed" ||
      frontierSet.has(node.id);
    return {
      id: node.id,
      type: "missionNode",
      position: positions[node.id] ?? { x: 0, y: 0 },
      data: {
        label: node.title,
        nodeType: node.type,
        status: node.status,
        description: node.description,
        emphasis
      }
    };
  });

  const edges: FlowEdgeDto[] = graph.edges.map((edge, i) => ({
    id: `e_${edge.from}_${edge.to}_${i}`,
    source: edge.from,
    target: edge.to,
    animated: Boolean(validIds.has(edge.from) && validIds.has(edge.to)),
    highlighted: shouldHighlightEdge(graph, edge, frontierSet),
    edgeType: "smoothstep"
  }));

  return { nodes, edges, overlay };
}
