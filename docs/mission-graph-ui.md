# Mission graph UI (Cockpit)

This document complements [`docs/cockpit.md`](cockpit.md) with **execution overlay**, **layout**, and **persistence** semantics for the visual plan graph.

## Layout vs execution state

| Concern | Source of truth | Notes |
|---------|-----------------|--------|
| Node **status** (`pending`, `ready`, `completed`, …) | `graph.json` / mission `planGraph` | Updated by the executor and tools; authoritative for “where the mission is”. |
| **Ledger** `node.started` / `node.completed` / `node.failed` | `ledger.jsonl` | Corroborates lifecycle; surfaced per node id in `details.nodeId`. |
| **On-screen positions** | `graph-view.json` (sidecar) | View-only. Does **not** affect execution. Merged via `PATCH /api/missions/:id/graph/view`. |
| **Auto layout** | Dagre (`rankdir: TB`) | Applied server-side when building the graph DTO; saved positions override auto layout for known node ids. |

Checkpoints in the product vision may also capture **graph position** as part of a broader checkpoint payload; today Narthynx stores layout only in `graph-view.json`.

## Execution frontier

**Frontier nodes** are incomplete nodes whose **predecessors are all `completed`**. On a linear plan this is usually the single “next” step; with joins or multiple roots, several ids may appear.

The API includes:

- `graph.overlay.frontierNodeIds`
- `graph.overlay.byNodeId[*].ledgerPhase` / `lastLedgerEventType` derived from ledger order

## Edge highlighting (heuristic)

Edge `highlighted` is a **read-only hint** for the UI:

- Completed “spine” edges (from a completed node to a completed or frontier node).
- Edges leaving the frontier toward incomplete work.
- Bootstrap: root → frontier when nothing is completed yet.

This is **not** a full branch-aware shortest-path algorithm. When the plan graph gains conditional edges (Phase C), expect to replace or extend this heuristic (e.g. ELK + labeled edges).

## Phase C — Branching and recovery (Codex roadmap)

Today’s [mission edge schema](../src/missions/graph.ts) is `{ from, to }` only. The Codex **Mission Graph Runtime** calls for **branches, recoveries, and artifacts** as first-class graph semantics.

Planned direction (not implemented here):

1. Extend edges with `kind` or labels (`always`, `on_success`, `on_failure`, parallel lanes).
2. Teach the executor which outgoing edge to follow after `node.failed` (recovery subgraphs).
3. Prefer a layout engine with richer routing (e.g. ELK) when forks multiply.

Until then, the UI remains valid for **DAG-shaped** MVP plans and degrades visually when the graph is dense—operators can still rely on node status and the ledger.
