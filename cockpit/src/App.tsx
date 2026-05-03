import React from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";

import { clearStoredToken, cockpitFetch, getStoredToken } from "./api";
import { Dashboard } from "./pages/Dashboard";
import { Login } from "./pages/Login";
import { MissionDetail } from "./pages/MissionDetail";
import "./index.css";

export function App(): React.ReactElement {
  const authed = Boolean(getStoredToken());

  return (
    <div className="layout">
      <nav className="nav">
        <Link to="/">Cockpit</Link>
        {authed ? (
          <>
            <Link to="/missions">Missions</Link>
            <Link to="/approvals">Approvals</Link>
            <button
              type="button"
              className="btn"
              onClick={() => {
                clearStoredToken();
                window.location.assign("/login");
              }}
            >
              Sign out
            </button>
          </>
        ) : null}
      </nav>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={authed ? <Navigate to="/missions" replace /> : <Navigate to="/login" replace />} />
        <Route path="/missions" element={authed ? <Dashboard /> : <Navigate to="/login" replace />} />
        <Route path="/missions/:missionId" element={authed ? <MissionDetail /> : <Navigate to="/login" replace />} />
        <Route path="/approvals" element={authed ? <ApprovalsPage /> : <Navigate to="/login" replace />} />
      </Routes>
    </div>
  );
}

function ApprovalsPage(): React.ReactElement {
  const [error, setError] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<
    Array<{
      id: string;
      missionId: string;
      toolName: string;
      riskLevel: string;
      prompt: string;
    }>
  >([]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await cockpitFetch("/api/approvals/pending");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { approvals: typeof items };
        if (!cancelled) {
          setItems(data.approvals);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function decide(id: string, decision: "approved" | "denied"): Promise<void> {
    const reason =
      decision === "denied"
        ? window.prompt("Denial reason (optional)") ?? undefined
        : window.prompt("Optional note") ?? undefined;
    const res = await cockpitFetch(`/api/approvals/${encodeURIComponent(id)}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason: reason || undefined })
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      alert(body.error ?? res.statusText);
      return;
    }
    window.location.reload();
  }

  return (
    <div>
      <h1>Pending approvals</h1>
      {error ? <p className="error">{error}</p> : null}
      {items.length === 0 ? <p>No pending approvals.</p> : null}
      {items.map((a) => (
        <div key={a.id} className="card">
          <div>
            <strong>{a.id}</strong> — {a.toolName} ({a.riskLevel})
          </div>
          <div style={{ margin: "0.5rem 0" }}>
            Mission:{" "}
            <Link to={`/missions/${a.missionId}`}>
              {a.missionId}
            </Link>
          </div>
          <div className="pre">{a.prompt}</div>
          <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
            <button type="button" className="btn btn-primary" onClick={() => void decide(a.id, "approved")}>
              Approve
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void decide(a.id, "denied")}>
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
