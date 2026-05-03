import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  Handle,
  Position,
  type Node,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import React from "react";
import { Link, useParams } from "react-router-dom";

import { cockpitFetch } from "../api";

const nodeTypes = { missionNode: MissionNodeView };

const ACTIVE_POLL_MS = 4_000;

interface GraphOverlay {
  frontierNodeIds: string[];
  byNodeId: Record<string, { ledgerPhase?: string; lastLedgerEventType?: string }>;
}

interface MissionNodeData {
  label: string;
  nodeType: string;
  status: string;
  description: string;
  emphasis: boolean;
}

function MissionNodeView(props: NodeProps): React.ReactElement {
  const d = props.data as MissionNodeData;
  return (
    <div
      className={`mission-node mission-node--${d.nodeType} ${d.emphasis ? "mission-node--emphasis" : ""} ${d.status === "failed" ? "mission-node--failed" : ""}`}
    >
      <Handle type="target" position={Position.Top} />
      <strong>{d.label}</strong>
      <div className="mission-node-meta">
        <span className="status-pill">{d.nodeType}</span>
        <span className={`status-badge status-${d.status}`}>{d.status}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function toFlowNodes(
  nodes: Array<{
    id: string;
    type?: string;
    position: { x: number; y: number };
    data: MissionNodeData;
  }>
): Node[] {
  return nodes.map((n) => ({
    ...n,
    type: n.type ?? "missionNode"
  }));
}

function toFlowEdges(
  edges: Array<{
    id: string;
    source: string;
    target: string;
    animated: boolean;
    highlighted: boolean;
    edgeType: "smoothstep";
  }>
): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: e.edgeType,
    animated: e.highlighted,
    style: {
      opacity: e.highlighted ? 1 : 0.32,
      stroke: e.highlighted ? "var(--graph-edge-active)" : "var(--graph-edge-muted)",
      strokeWidth: e.highlighted ? 2.5 : 1
    },
    zIndex: e.highlighted ? 2 : 0
  }));
}

type Tab = "overview" | "graph" | "ledger" | "replay" | "report";

type MissionOverview = {
  mission?: { title: string; goal: string; state: string };
};

export function MissionDetail(): React.ReactElement {
  const { missionId = "" } = useParams();
  const [tab, setTab] = React.useState<Tab>("overview");
  const [overview, setOverview] = React.useState<MissionOverview | null>(null);
  const [flowNodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [graphOverlay, setGraphOverlay] = React.useState<GraphOverlay | null>(null);
  const [graphMissionState, setGraphMissionState] = React.useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
  const [ledger, setLedger] = React.useState<unknown>(null);
  const [replay, setReplay] = React.useState<unknown>(null);
  const [report, setReport] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const saveLayoutTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fetchGraph = React.useCallback(async (): Promise<void> => {
    const res = await cockpitFetch(`/api/missions/${encodeURIComponent(missionId)}/graph`);
    if (!res.ok) {
      throw new Error("Graph fetch failed");
    }
    const data = (await res.json()) as {
      graph: {
        nodes: Array<{
          id: string;
          type?: string;
          position: { x: number; y: number };
          data: MissionNodeData;
        }>;
        edges: Array<{
          id: string;
          source: string;
          target: string;
          animated: boolean;
          highlighted: boolean;
          edgeType: "smoothstep";
        }>;
        overlay: GraphOverlay;
      };
      missionState: string;
    };
    setNodes(toFlowNodes(data.graph.nodes));
    setEdges(toFlowEdges(data.graph.edges));
    setGraphOverlay(data.graph.overlay);
    setGraphMissionState(data.missionState);
  }, [missionId, setNodes, setEdges]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const res = await cockpitFetch(`/api/missions/${encodeURIComponent(missionId)}`);
        if (!res.ok) {
          throw new Error(await res.text());
        }
        const data = (await res.json()) as MissionOverview;
        if (!cancelled) {
          setOverview(data);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Load failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  React.useEffect(() => {
    if (tab !== "graph") {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await fetchGraph();
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Graph error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missionId, tab, fetchGraph]);

  React.useEffect(() => {
    if (tab !== "graph") {
      return;
    }
    const state = overview?.mission?.state ?? graphMissionState;
    if (state !== "running" && state !== "paused") {
      return;
    }
    const id = window.setInterval(() => {
      void fetchGraph().catch(() => {
        /* ignore transient poll errors */
      });
    }, ACTIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [tab, overview?.mission?.state, graphMissionState, fetchGraph]);

  React.useEffect(() => {
    if (tab !== "ledger") {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await cockpitFetch(`/api/missions/${encodeURIComponent(missionId)}/ledger?limit=200`);
        if (!res.ok) {
          throw new Error("Ledger fetch failed");
        }
        const data = await res.json();
        if (!cancelled) {
          setLedger(data);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Ledger error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missionId, tab]);

  React.useEffect(() => {
    if (tab !== "replay") {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await cockpitFetch(`/api/missions/${encodeURIComponent(missionId)}/replay`);
        if (!res.ok) {
          throw new Error("Replay fetch failed");
        }
        const data = await res.json();
        if (!cancelled) {
          setReplay(data);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Replay error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missionId, tab]);

  React.useEffect(() => {
    if (tab !== "report") {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await cockpitFetch(`/api/missions/${encodeURIComponent(missionId)}/report`);
        if (!res.ok) {
          setReport(null);
          if (!cancelled) {
            setError("Report not available yet.");
          }
          return;
        }
        const data = (await res.json()) as { markdown: string };
        if (!cancelled) {
          setReport(data.markdown);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Report error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missionId, tab]);

  const onNodeDragStop = React.useCallback(
    (_: unknown, node: Node) => {
      window.clearTimeout(saveLayoutTimer.current);
      saveLayoutTimer.current = window.setTimeout(() => {
        void (async () => {
          try {
            await cockpitFetch(`/api/missions/${encodeURIComponent(missionId)}/graph/view`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                positions: { [node.id]: { x: node.position.x, y: node.position.y } }
              })
            });
          } catch {
            /* non-fatal */
          }
        })();
      }, 400);
    },
    [missionId]
  );

  const selectedNode = flowNodes.find((n) => n.id === selectedNodeId);
  const selectedData = selectedNode?.data as MissionNodeData | undefined;
  const selectedOverlay =
    selectedNodeId && graphOverlay?.byNodeId ? graphOverlay.byNodeId[selectedNodeId] : undefined;

  const mission = overview;

  return (
    <div>
      <p>
        <Link to="/missions">← Missions</Link>
      </p>
      <h1>{mission?.mission?.title ?? missionId}</h1>
      {error ? <p className="error">{error}</p> : null}
      <div className="tabs">
        {(["overview", "graph", "ledger", "replay", "report"] as const).map((t) => (
          <button key={t} type="button" className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "overview" && mission?.mission ? (
        <div className="card">
          <p>
            <strong>State</strong> {mission.mission.state}
          </p>
          <p>
            <strong>Goal</strong> {mission.mission.goal}
          </p>
        </div>
      ) : null}
      {tab === "graph" ? (
        <div className="graph-page">
          <div className="flow-wrap flow-wrap--main">
            <ReactFlowProvider>
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={(_, n) => setSelectedNodeId(n.id)}
                onPaneClick={() => setSelectedNodeId(null)}
                onNodeDragStop={onNodeDragStop}
                fitView
                minZoom={0.2}
                maxZoom={1.5}
                attributionPosition="bottom-left"
              >
                <MiniMap />
                <Controls />
                <Background />
              </ReactFlow>
            </ReactFlowProvider>
          </div>
          <aside className="graph-inspector card">
            <h2>Graph inspector</h2>
            <p className="graph-inspector-hint">
              <strong>Frontier</strong> (next executable steps):{" "}
              {graphOverlay?.frontierNodeIds?.length
                ? graphOverlay.frontierNodeIds.join(", ")
                : "—"}
            </p>
            <p className="graph-inspector-hint">
              Filter ledger JSON for <code>details.nodeId</code> to correlate events.
            </p>
            {selectedData ? (
              <div className="graph-inspector-body">
                <h3>{selectedData.label}</h3>
                <p>
                  <span className="status-pill">{selectedData.nodeType}</span>{" "}
                  <span className={`status-badge status-${selectedData.status}`}>{selectedData.status}</span>
                </p>
                <p className="graph-inspector-desc">{selectedData.description}</p>
                <p>
                  <small>
                    Ledger hint:{" "}
                    {selectedOverlay?.ledgerPhase
                      ? `last lifecycle: ${selectedOverlay.ledgerPhase}`
                      : "no node.* ledger events yet"}
                  </small>
                </p>
              </div>
            ) : (
              <p className="muted">Select a node to inspect.</p>
            )}
          </aside>
        </div>
      ) : null}
      {tab === "ledger" && ledger ? <pre className="pre">{JSON.stringify(ledger, null, 2)}</pre> : null}
      {tab === "replay" && replay ? <pre className="pre">{JSON.stringify(replay, null, 2)}</pre> : null}
      {tab === "report" && report ? <pre className="pre">{report}</pre> : null}
    </div>
  );
}
