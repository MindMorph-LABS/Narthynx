import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

import { setStoredToken } from "../api";

export function Login(): React.ReactElement {
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    const trimmed = token.trim();
    if (!trimmed) {
      setErr("Token required");
      return;
    }
    setStoredToken(trimmed);
    const health = await fetch("/api/health", {
      headers: { Authorization: `Bearer ${trimmed}` }
    });
    if (!health.ok) {
      setErr(health.status === 401 ? "Invalid token" : `Health check failed (${health.status})`);
      return;
    }
    navigate("/missions", { replace: true });
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h1>Mission Cockpit</h1>
      <p>Enter the Bearer token printed when you run <code>narthynx cockpit</code>.</p>
      <form onSubmit={(ev) => void submit(ev)}>
        <label htmlFor="token" style={{ display: "block", marginBottom: "0.5rem" }}>
          Token
        </label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ width: "100%", padding: "0.5rem", marginBottom: "0.75rem" }}
        />
        {err ? <p className="error">{err}</p> : null}
        <button type="submit" className="btn btn-primary">
          Connect
        </button>
      </form>
    </div>
  );
}
