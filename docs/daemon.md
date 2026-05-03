# Narthynx daemon (Frontier F16)

The **always-on daemon** is a localhost-first supervisor: background queue, durable event log, optional schedules, and HTTP control plane. It shares the same `.narthynx/` workspace, **policy.yaml**, and mission store as the CLI.

## Phase crosswalk

Frontier phases (see `AGENTS_APPENDIX_PHASE_16_30.md`) are numbered separately from **connector** phases in `docs/roadmap.md`:

| Label        | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| **Frontier F16** | Always-on daemon (this document)                |
| **Connector C16** | Browser (Playwright) tools — roadmap “Phase 16”   |
| **Connector C17** | MCP stdio connector — roadmap “Phase 17”       |
| **Connector C18** | GitHub REST connector — roadmap “Phase 18”       |

## Security defaults

- HTTP API binds to **127.0.0.1** by default. LAN binding requires an explicit `--danger-listen-lan` flag (not recommended unless you understand the risk).
- **Bearer token**: environment variable `NARTHYNX_DAEMON_TOKEN` overrides the file `.narthynx/daemon/token` (same pattern as cockpit). Do not commit tokens.
- The daemon applies **`daemon_background_actions`** in `policy.yaml` (see below). High-risk tools still require human approval via the existing approval queue; the daemon never approves on your behalf.

## Environment variables

| Variable                  | Purpose                                      | Default                    |
| ------------------------- | -------------------------------------------- | -------------------------- |
| `NARTHYNX_DAEMON_TOKEN`   | API Bearer secret                            | (read/write `daemon/token`) |
| `NARTHYNX_DAEMON_PORT`    | TCP port                                     | `17891`                    |
| `NARTHYNX_DAEMON_HOST`    | Bind address                                 | `127.0.0.1`                |

## CLI

```bash
narthynx daemon start   [--foreground] [--port N] [--cwd DIR]
narthynx daemon stop    [--cwd DIR]
narthynx daemon status  [--cwd DIR]
narthynx daemon logs    [--cwd DIR] [--lines N]
```

- **start** without `--foreground` spawns a detached child process (`daemon internal-run`).
- **foreground** keeps the daemon in the current terminal for development.

Interactive shell (when the daemon is running): `/daemon`, `/events`, `/queue`.

## Policy: `daemon_background_actions`

Allowed values:

- **`observe_only`** — internal events and notifications only; no mission creation or executor runs.
- **`draft_and_notify`** — may enqueue **notify** jobs and **create_mission** (draft missions in `created` state).
- **`allow_low_risk_automation`** — may run **`execute_mission`** via the bounded mission executor (tools still obey normal policy and approval gates).

## Local files

Artifacts under `.narthynx/daemon/`:

- `daemon.lock` — single-instance lock
- `daemon.pid` — PID of the running daemon (when supervised)
- `status.json` — last published status snapshot
- `events.jsonl` — append-only daemon events
- `queue.jsonl` — append-only queue operations (replay for recovery)
- `schedule.yaml` — schedule definitions
- `schedule-state.json` — last fire timestamps
- `daemon.log` — redacted rotating-style append log (bounded tail for `daemon logs`)

## HTTP API (`/api/daemon/v1`)

All routes require header `Authorization: Bearer <token>`.

| Method | Path      | Notes                                      |
| ------ | --------- | ------------------------------------------ |
| GET    | `/health` | Workspace doctor summary + uptime          |
| GET    | `/status` | Daemon status JSON                         |
| GET    | `/queue`  | Pending job summaries                      |
| POST   | `/queue`  | Enqueue job (validated + policy-checked)    |
| GET    | `/events` | Query `?since=<ISO>` for recent events      |

## Companion reminders (`companion/reminders.jsonl`, Frontier F17)

`/remind` (interactive shell) appends timed rows under `.narthynx/companion/reminders.jsonl`. On each foreground daemon tick (`run.ts`), **due** reminders (pending + `fireAt <= now`) are delivered as:

1. **`notify`** sink emission (visible in daemon log output), and
2. Daemon event **`companion.reminder.delivered`** appended to `.narthynx/daemon/events.jsonl`.

Companion reminders intentionally **skip** the main FIFO `queue.jsonl` so unrelated jobs cannot be blocked waiting on a deferred clock row.

Without a running daemon, reminders stay **pending**; the CLI states this explicitly after scheduling.

## Limitations (honest)

- Single worker process; **no clustered daemon**.
- Queue is JSONL-backed — high concurrency enqueue from many processes may contend; localhost control plane assumes low fan-in.
- Schedules support **interval minutes** only (no full cron grammar in F16).

## Relationship to cockpit

The Mission Cockpit (`narthynx cockpit`) stays a separate server on its own port. The daemon API is independent; future work may proxy cockpit to daemon for unified status.
