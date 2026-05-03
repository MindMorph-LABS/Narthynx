import type { PlanGraph } from "./graph";
import type { LedgerEvent, LedgerEventType } from "./ledger";

const NODE_LEDGER_TYPES = new Set<LedgerEventType>(["node.started", "node.completed", "node.failed"]);

export interface NodeOverlayEntry {
  lastLedgerEventType?: LedgerEventType;
  /** Last matching node lifecycle event in ledger order for this node id. */
  ledgerPhase?: "started" | "completed" | "failed";
}

export interface GraphExecutionOverlay {
  byNodeId: Record<string, NodeOverlayEntry>;
  /** Nodes eligible to run next: incomplete, all predecessors completed. */
  frontierNodeIds: string[];
}

function readNodeId(details: unknown): string | null {
  if (!details || typeof details !== "object") {
    return null;
  }
  const id = (details as { nodeId?: unknown }).nodeId;
  return typeof id === "string" ? id : null;
}

/**
 * Merge authoritative plan-graph node state with ledger hints (nodeId in details).
 */
export function buildGraphExecutionOverlay(graph: PlanGraph, ledgerEvents: LedgerEvent[]): GraphExecutionOverlay {
  const byNodeId: Record<string, NodeOverlayEntry> = {};
  for (const n of graph.nodes) {
    byNodeId[n.id] = {};
  }

  for (const ev of ledgerEvents) {
    const nid = readNodeId(ev.details);
    if (!nid || !byNodeId[nid]) {
      continue;
    }
    if (!NODE_LEDGER_TYPES.has(ev.type)) {
      continue;
    }
    const entry = byNodeId[nid];
    entry.lastLedgerEventType = ev.type;
    if (ev.type === "node.started") {
      entry.ledgerPhase = "started";
    } else if (ev.type === "node.completed") {
      entry.ledgerPhase = "completed";
    } else if (ev.type === "node.failed") {
      entry.ledgerPhase = "failed";
    }
  }

  return {
    byNodeId,
    frontierNodeIds: computeFrontierNodeIds(graph)
  };
}

/** Nodes with no incoming edges. */
export function computeRootNodeIds(graph: PlanGraph): Set<string> {
  const withIncoming = new Set(graph.edges.map((e) => e.to));
  return new Set(graph.nodes.filter((n) => !withIncoming.has(n.id)).map((n) => n.id));
}

/**
 * Execution frontier: incomplete nodes whose predecessors are all completed.
 * Matches a linear DAG executor; multiple roots / join nodes yield multiple frontier ids.
 */
export function computeFrontierNodeIds(graph: PlanGraph): string[] {
  const completed = new Set(graph.nodes.filter((n) => n.status === "completed").map((n) => n.id));
  const preds = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!preds.has(e.to)) {
      preds.set(e.to, []);
    }
    preds.get(e.to)!.push(e.from);
  }

  const frontier: string[] = [];
  for (const n of graph.nodes) {
    if (n.status === "completed" || n.status === "failed") {
      continue;
    }
    const p = preds.get(n.id) ?? [];
    const allPredsDone = p.length === 0 || p.every((id) => completed.has(id));
    if (allPredsDone) {
      frontier.push(n.id);
    }
  }
  return frontier;
}

/**
 * Edge emphasis heuristic: completed spine + exit from frontier toward incomplete work.
 * Documented for cockpit; not a full branch-aware path finder (see Phase C in mission-graph doc).
 */
export function shouldHighlightEdge(graph: PlanGraph, edge: { from: string; to: string }, frontierIds: Set<string>): boolean {
  const completed = new Set(graph.nodes.filter((n) => n.status === "completed").map((n) => n.id));
  const roots = computeRootNodeIds(graph);
  const fromC = completed.has(edge.from);
  const toC = completed.has(edge.to);
  const toF = frontierIds.has(edge.to);
  const fromF = frontierIds.has(edge.from);

  if (fromC && (toC || toF)) {
    return true;
  }
  if (fromF && !toC) {
    return true;
  }
  if (roots.has(edge.from) && toF && completed.size === 0) {
    return true;
  }
  return false;
}
