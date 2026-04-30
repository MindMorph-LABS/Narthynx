# Connectors

Narthynx connectors are typed tools. They must go through schemas, policy classification, approval gates where needed, ledger events, and durable artifacts.

## Phase 11 Tools

### `shell.run`

`shell.run` runs a local command only after approval.

```json
{
  "command": "node",
  "args": ["--version"],
  "cwd": ".",
  "timeoutMs": 5000
}
```

Safety behavior:

- uses `spawn` with `shell: false`
- blocks shell metacharacters such as pipes, redirects, command chaining, and subshell syntax
- blocks destructive patterns such as recursive force deletion, shutdown, formatting, privilege escalation, and download-to-shell shapes
- restricts `cwd` to the workspace root or descendants
- records requested, denied/approved, started, completed, and failed events in the ledger
- writes captured stdout/stderr to `artifacts/outputs/`

Shell actions are not treated as reversible. Narthynx records what happened but does not pretend it can roll back arbitrary commands.

### `git.diff`

`git.diff` is a read-only connector that runs Git without a shell and captures diff output as a mission artifact when inside a Git repository.

### `git.log`

`git.log` is a read-only connector that runs Git without a shell and captures recent commit history as a mission artifact when inside a Git repository.

## Anti-Goals

Phase 11 does not add mutating Git commands, raw shell strings, network connectors, external communication, browser automation, or hosted execution.

## Phase 12 Model Providers

Model providers are not typed tools; they are routed through `src/agent/model-router.ts` and recorded in each mission ledger.

- Default provider: `stub`, deterministic, local-only, zero cost.
- Optional provider: OpenAI-compatible chat completions through Node `fetch`.
- Required env for cloud provider: `NARTHYNX_MODEL_PROVIDER=openai-compatible`, `NARTHYNX_OPENAI_BASE_URL`, `NARTHYNX_OPENAI_API_KEY`, and `NARTHYNX_OPENAI_MODEL`.
- Cloud calls require `allow_network: true`.
- `/cost` and `narthynx cost <mission-id>` summarize model calls, tokens, estimated cost, and sensitive-context usage.
- Phase 12 only wires model routing into explicit plan generation through `plan --model`; it does not execute missions autonomously.
