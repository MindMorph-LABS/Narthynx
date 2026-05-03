# Local Web Mission Cockpit

The Mission Cockpit is a **local-only** HTTP server and browser UI that reads and updates mission data through the same stores and services as the CLI (`createMissionStore`, `createApprovalStore`, ledger, replay, reports, and the tool runner’s `runApprovedTool` after an approval—matching `narthynx approve`).

It is **not** a hosted product surface: there is no telemetry and no cloud dependency.

## Run

From an initialized workspace (after `narthynx init` / `pnpm narthynx init`):

```bash
pnpm narthynx cockpit
# or after global/link install:
narthynx cockpit
```

Defaults:

- **Bind address:** `127.0.0.1`
- **Port:** `17890`, overridable with `--port` or env `NARTHYNX_COCKPIT_PORT`

Open the printed URL (for example `http://127.0.0.1:17890`). Paste the **Bearer token** from the terminal into the login screen.

## Authentication

Every `/api/*` request must send:

```http
Authorization: Bearer <token>
```

The token is resolved in order:

1. Environment variable `NARTHYNX_COCKPIT_TOKEN` (recommended for automation or CI).
2. Otherwise, the file `.narthynx/cockpit/token` (created on first run if missing).

Treat the token like a password for the cockpit API.

## Security and threat model

- **Loopback by default:** The server binds to `127.0.0.1` so other machines cannot connect unless you change binding.
- **LAN exposure:** Use `--danger-listen-on-lan` only if you intend to reach the cockpit from another device. That flag forces bind `0.0.0.0` and prints a stderr warning. In that mode, CORS is opened for browser access from non-local origins; you must use a **strong** `NARTHYNX_COCKPIT_TOKEN` and understand that anyone who can reach your machine on that port can call the API with the token.
- **No shell from the browser:** The UI only talks to typed JSON routes; it does not spawn arbitrary shell commands.
- **Token file permissions:** On Unix, create the token file with restrictive permissions where possible. On Windows, normal file ACLs apply—rely on loopback binding and a strong token.

## Development (UI)

The SPA lives under `cockpit/`. Run the cockpit server, then from the **repository root**:

```bash
pnpm narthynx cockpit
# other terminal:
pnpm exec vite --config cockpit/vite.config.ts
```

Vite proxies `/api` to `http://127.0.0.1:17890` (the cockpit server must be running).

Production assets are emitted to `dist/cockpit` by `pnpm build:cockpit`, which runs as part of `pnpm build` after the CLI bundle is built.

See [`docs/mission-graph-ui.md`](mission-graph-ui.md) for frontier, edge-highlight, and layout persistence semantics.

## API overview

All routes are under `/api` and require the Bearer token unless noted.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Workspace doctor summary |
| GET | `/api/missions` | List missions |
| GET | `/api/missions/:missionId` | Mission detail |
| GET | `/api/missions/:missionId/graph` | Plan graph **view DTO**: Dagre layout, execution `overlay` (frontier + per-node ledger hints), `smoothstep` edges with `highlighted`; includes `missionState` and `raw` plan graph |
| PATCH | `/api/missions/:missionId/graph/view` | Body: `{ positions: Record<nodeId, { x, y }> }` merges into `graph-view.json` (view-only layout); unknown node ids ignored |
| GET | `/api/missions/:missionId/ledger` | Ledger events (`limit` query) |
| GET | `/api/missions/:missionId/replay` | Replay payload |
| GET | `/api/missions/:missionId/report` | Report markdown |
| GET | `/api/missions/:missionId/report/path` | Report file paths (absolute + workspace-relative) |
| GET | `/api/approvals/pending` | Pending approvals |
| POST | `/api/approvals/:approvalId/decide` | Body: `{ decision: "approved" \| "denied", reason?: string }` |

Approving triggers the same post-decision tool execution path as the CLI when applicable.

## Non-goals (v1)

Running or resuming the mission executor from the browser is intentionally omitted to avoid double-driving execution; use the CLI `run` / `resume` flows until a dedicated, mutexed design exists.
