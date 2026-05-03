import React from "react";
import { Link } from "react-router-dom";

import { cockpitFetch } from "../api";

interface MissionRow {
  id: string;
  title: string;
  state: string;
  riskLevel: string;
  updatedAt: string;
}

export function Dashboard(): React.ReactElement {
  const [rows, setRows] = React.useState<MissionRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await cockpitFetch("/api/missions");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { missions: MissionRow[] };
        if (!cancelled) {
          setRows(data.missions);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load missions");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="error">{error}</p>;
  }
  if (!rows) {
    return <p>Loading missions…</p>;
  }

  return (
    <div>
      <h1>Missions</h1>
      {rows.length === 0 ? <p>No missions yet. Create one with the CLI.</p> : null}
      {rows.length > 0 ? (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>State</th>
                <th>Risk</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link to={`/missions/${m.id}`}>{m.id}</Link>
                  </td>
                  <td>{m.title}</td>
                  <td>{m.state}</td>
                  <td>{m.riskLevel}</td>
                  <td>{m.updatedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
