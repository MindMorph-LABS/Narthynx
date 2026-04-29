# Mission Specification

Narthynx is a local-first Mission Agent OS. Its core primitive is the durable **Mission**, not a chat message or an unstructured sequence of tool calls.

A Mission turns serious work into an inspectable unit with a goal, success criteria, plan graph, action ledger, checkpoints, approvals, artifacts, reports, and replayable execution history.

## Mission Interface

Every Mission must support at least this shape:

```ts
type MissionState =
  | "created"
  | "planning"
  | "running"
  | "waiting_for_approval"
  | "paused"
  | "verifying"
  | "failed"
  | "recovering"
  | "completed"
  | "cancelled";

type RiskLevel = "low" | "medium" | "high" | "critical";

interface Mission {
  id: string;
  title: string;
  goal: string;
  successCriteria: string[];
  context: MissionContext;
  planGraph: PlanGraph;
  state: MissionState;
  riskProfile: RiskProfile;
  checkpoints: Checkpoint[];
  approvals: ApprovalRequest[];
  artifacts: Artifact[];
  ledger: LedgerEvent[];
  createdAt: string;
  updatedAt: string;
}
```

This interface is the product contract. Future implementation details can refine supporting types, but they must preserve the mission-native model.

## MissionState Lifecycle

The intended lifecycle is:

```txt
created -> planning -> running -> verifying -> completed
running -> waiting_for_approval -> running
running -> failed -> recovering -> running
running -> paused -> running
any -> cancelled
```

All state transitions must be persisted before the user is told they happened. If a process exits or crashes, Narthynx must resume from the last persisted safe state.

## Mission Graph Nodes

The mission graph is the execution plan and history backbone. Narthynx must not collapse missions into a plain message loop.

```ts
type MissionNodeType =
  | "research"
  | "action"
  | "approval"
  | "verification"
  | "recovery"
  | "handoff"
  | "artifact";
```

| Node type | Purpose |
| --- | --- |
| `research` | Gather information from files, logs, docs, or connectors |
| `action` | Perform a typed tool operation |
| `approval` | Pause until a human accepts or rejects an action |
| `verification` | Check whether success criteria are met |
| `recovery` | Define fallback work after failure |
| `handoff` | Ask the user to manually perform a step |
| `artifact` | Create a durable output |

Every graph transition must be recorded before and after execution. On crash, execution resumes from the last safe persisted step.

## Ledger

Every mission must have an append-only ledger. The ledger is the source of traceability and replay.

Expected event types include:

```ts
type LedgerEventType =
  | "mission.created"
  | "mission.state_changed"
  | "plan.created"
  | "plan.updated"
  | "node.started"
  | "node.completed"
  | "node.failed"
  | "tool.requested"
  | "tool.approved"
  | "tool.denied"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "checkpoint.created"
  | "artifact.created"
  | "model.called"
  | "cost.recorded"
  | "user.note"
  | "error";
```

The ledger must make `narthynx replay <mission-id>` possible. No hidden action should be missing from replay.
