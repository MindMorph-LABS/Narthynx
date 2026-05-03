# Bounded subagents (Frontier F20)

Narthynx **subagents** are narrow, ledger-attributed “expert hats” that reuse the existing **model router** and **`createToolRunner`** tool path. They are **budget-limited**, **policy-intersected**, and **not autonomous swarms**.

## Thesis

- **Verifier** — deterministic checks (report artifact presence, readable plan graph sanity) plus room for optional future LM summaries keyed as `subagent_verifier`.
- **Safety** — frozen **hypothetical** tool call reviewed with heuristic gates plus optional **`subagent_safety`** routing.
- **Critic** — composes verifier + optional safety phase; capped at low turn budget (two internal turns only when a hypothetical tool is provided).
- **Planner** — draft-only **PlanGraph** JSON proposals via **`subagent_planner`**; persisting graphs requires **`narthynx subagents run planner <id> --apply --yes`** when `requireExplicitApply` is true.

## `.narthynx/subagents.yaml`

Optional YAML; when missing, typed defaults ship from `DEFAULT_SUBAGENTS_CONFIG`.

- **`enabled`** — global kill-switch.
- **`profiles.<slug>`** — merged with kind defaults (`planner`, `verifier`, `safety`, `critic`):
  - `allowedTools`: non-empty = strict allow-list; empty = all tools except forbids intersect policy.
  - `forbiddenTools`: hard denies before any runner invocation.
  - `maxTurns`, `maxToolCallsPerSession`, `maxModelCallsPerSession`, `riskBoundary`.
  - `requireExplicitApply` — planner persistence guardrail.

## Model routing tasks

Declare routes in **`model-routing.yaml`** for honest budgeting and endpoint choice:

| Task key | Purpose |
| --- | --- |
| `subagent_planner` | PlanGraph draft/refinement payloads |
| `subagent_verifier` | Reserved for optional LM verifier summaries (MVP is deterministic-first) |
| `subagent_safety` | JSON safety envelopes on hypothetical tool payloads |

Absent routes fall back to the normal router env/default chain (typically stub-first).

## Ledger events

Attributed subagent telemetry (replay-safe, compact summaries):

| Type | Meaning |
| --- | --- |
| `subagent.session_started` | Session boundary + principal `subagent:<profileId>` |
| `subagent.turn` | Checkpoint within a session (includes verifier/safety summaries) |
| `subagent.completed` | Success with budget snapshot + sanitized output |
| `subagent.failed` | Hard stop including budget exhaustion / validation errors |
| `subagent.tool_blocked` | Gate denied before tool runner (`forbidden`, allow-list, or runner denial) |

## CLI

```bash
narthynx subagents list
narthynx subagents inspect verifier
narthynx subagents run verifier <mission-id>
narthynx subagents run safety <mission-id> --tool filesystem.write --input-json '{"path":"notes.txt","content":"x"}'
narthynx subagents run planner <mission-id>            # dry-run draft (default)
narthynx subagents run planner <mission-id> --apply --yes
```

Slash analogues: `/subagents …`, `/verify`, `/critique`.

## MVP limitations

- No multi-agent debates, nesting, or subagent‑spawn‑subagent sessions.
- No standalone Cost/Memory agents in this frontier slice.
- “Tool executor” behavior equals **delegation through** `createToolRunner` with approvals unchanged—subagents cannot self-approve.
