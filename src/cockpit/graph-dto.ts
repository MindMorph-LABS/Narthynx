import type { PlanGraph } from "../missions/graph";

export interface FlowNodeDto {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    nodeType: string;
    status: string;
    description: string;
  };
}

export interface FlowEdgeDto {
  id: string;
  source: string;
  target: string;
  animated: boolean;
}

export interface PlanGraphFlowDto {
  nodes: FlowNodeDto[];
  edges: FlowEdgeDto[];
}

/** Map persisted plan graph to a React Flow–compatible DTO. */
export function planGraphToFlowDto(graph: PlanGraph): PlanGraphFlowDto {
  const columnWidth = 280;
  const rowHeight = 96;
  const byId = new Map(graph.nodes.map((n) => [n.id, true] as const));

  const nodes: FlowNodeDto[] = graph.nodes.map((node, index) => ({
    id: node.id,
    type: "missionNode",
    position: { x: 0, y: index * rowHeight },
    data: {
      label: node.title,
      nodeType: node.type,
      status: node.status,
      description: node.description
    }
  }));

  void columnWidth;

  const edges: FlowEdgeDto[] = graph.edges.map((edge, i) => ({
    id: `e_${edge.from}_${edge.to}_${i}`,
    source: edge.from,
    target: edge.to,
    animated: Boolean(byId.has(edge.from) && byId.has(edge.to))
  }));

  return { nodes, edges };
}
