import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
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

function MissionNodeView(props: NodeProps): React.ReactElement {
  const d = props.data as {
    label: string;
    nodeType: string;
    status: string;
    description: string;
  };
  return (
    <div className="mission-node">
      <Handle type="target" position={Position.Top} />
      <strong>{d.label}</strong>
      <div>
        <span className="status-pill">{d.nodeType}</span> {d.status}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

type Tab = "overview" | "graph" | "ledger" | "replay" | "report";

export function MissionDetail(): React.ReactElement {
  const { missionId = "" } = useParams();
  const [tab, setTab] = React.useState<Tab>("overview");
  const [overview, setOverview] = React.useState<unknown>(null);
  const [flowNodes, setFlowNodes] = React.useState<Node[]>([]);
  const [flowEdges, setFlowEdges] = React.useState<Edge[]>([]);
  const [ledger, setLedger] = React.useState<unknown>(null);
  const [replay, setReplay] = React.useState<unknown>(null);
  const [report, setReport] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const res = await cockpitFetch(`/api/missions/${encodeURIComponent(missionId)}`);
        if (!res.ok) {
          throw new Error(await res.text());
        }
        const data = await res.json();
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
        const res = await cockpitFetch(`/api/missions/${encodeURIComponent(missionId)}/graph`);
        if (!res.ok) {
          throw new Error("Graph fetch failed");
        }
        const data = (await res.json()) as {
          graph: { nodes: Node[]; edges: Edge[] };
        };
        if (!cancelled) {
          setFlowNodes(data.graph.nodes);
          setFlowEdges(data.graph.edges);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Graph error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missionId, tab]);

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

  const mission = overview as { mission?: { title: string; goal: string; state: string } } | null;

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
        <div className="flow-wrap">
          <ReactFlowProvider>
            <ReactFlow
              nodes={flowNodes as Node[]}
              edges={flowEdges as Edge[]}
              nodeTypes={nodeTypes}
              fitView
              attributionPosition="bottom-left"
            >
              <MiniMap />
              <Controls />
              <Background />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
      ) : null}
      {tab === "ledger" && ledger ? <pre className="pre">{JSON.stringify(ledger, null, 2)}</pre> : null}
      {tab === "replay" && replay ? <pre className="pre">{JSON.stringify(replay, null, 2)}</pre> : null}
      {tab === "report" && report ? <pre className="pre">{report}</pre> : null}
    </div>
  );
}
