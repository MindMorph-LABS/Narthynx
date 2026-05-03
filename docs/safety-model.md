# Safety Model

Safety is core product behavior in Narthynx. The goal is useful autonomy that remains local-first, inspectable, approval-gated, and recoverable.

## Safety Defaults

Narthynx must not weaken these defaults:

- no irreversible action without explicit approval
- no credential access by default
- no shell execution in Auto Mode
- no network by default in the MVP
- no external communication without approval
- every tool call must be logged
- every approval must be recorded
- every high-risk action must have a checkpoint
- no secrets should be sent to cloud models without explicit policy permission
- `.env`, SSH keys, token files, and credential stores must not be read unless a future explicit vault workflow exists

## Risk Levels

| Risk | Meaning | Required behavior |
| --- | --- | --- |
| Low | Read-only or harmless local context gathering | Allow and log |
| Medium | Creates local artifacts or runs non-destructive commands | Ask in strict mode, allow in trusted mode |
| High | Modifies important files, runs shell, sends messages, or uses network | Require approval and checkpoint |
| Critical | Credentials, destructive data changes, production config, or irreversible external actions | Block by default or require explicit typed confirmation |

High-risk actions must never run silently.

## Policy Modes

```txt
safe       -> read-only, no shell, no write, no network
ask        -> ask before medium/high risk
trusted    -> allow low/medium in workspace, ask high
approval   -> ask before every non-trivial action
```

No policy mode may allow high-risk actions silently.

## Default Policy

The default policy is local-first and conservative:

```yaml
mode: ask
allow_network: false
shell: ask
filesystem:
  read:
    - "."
  write:
    - "."
  deny:
    - ".env"
    - ".env.*"
    - "**/*secret*"
    - "~/.ssh/**"
external_communication: block
credentials: block
cloud_model_sensitive_context: ask
browser: block
browser_hosts_allow: []
browser_max_navigation_ms: 30000
browser_max_steps_per_session: 50
mcp: block
mcp_max_concurrent_sessions: 1
github: block
```

## Browser tools and policy

Browser tools (`browser.*`) are **off by default** (`browser: block`). Enabling them requires:

1. `browser: ask` (or future modes that allow browser classification)
2. `allow_network: true`
3. A **non-empty** `browser_hosts_allow` list matching each navigation URL

URLs outside the allowlist are blocked at input validation. See [`connectors.md`](connectors.md) for tool reference and `pnpm exec playwright install`.

## MCP and policy

`mcp` defaults to `block` on new workspaces. Set `mcp: ask` and optionally `mcp_servers_allow` before using MCP tools. `mcp.tools.call` is classified as **external communication**; allow it only with `external_communication: ask` (or looser) in addition to a non-`block` `mcp` setting.

MCP servers run as separate processes. Treat them as **high trust** and **high impact**: limit servers via `mcp.yaml`, use `tools_allow` / `tools_deny`, keep `external_communication` conservative, and rely on approvals for `mcp.tools.call`. Timeouts kill the session; large tool results spill to `mcp_tool_output` artifacts when they exceed per-server `maxOutputBytes`.

## GitHub tools and policy

`github` defaults to **`block`**. To use `github.*` tools, set **`github: ask`** (or stricter future modes), loosen **`external_communication`** from `block` as appropriate, and export **`GITHUB_TOKEN`** or **`GH_TOKEN`** in the environment—not in workspace or mission YAML.

Optional **`github_repos_allow`** in `policy.yaml` and **`repos_allow`** in `.narthynx/github.yaml` restrict which `owner/repo` pairs can be targeted; when both are set, only repos in the **intersection** are allowed. Large API payloads spill to **`github_api_response`** artifacts. See [`connectors.md`](connectors.md).

## Approval Prompt Format

Approval prompts must be explicit and copyable:

```txt
Action requires approval: filesystem.write
Mission: launch-readiness-review
Risk: High - local file modification
Target: ./LAUNCH_CHECKLIST.md

Options:
[a] approve once
[e] edit proposal
[d] deny
[p] pause mission
```

All approval outcomes must be written to the mission ledger.

## Blocked By Default

The MVP blocks or approval-gates behavior that can leave the local workspace or cause irreversible effects:

- credential access
- network access
- raw shell execution; typed `shell.run` is approval-gated and uses `shell: false`
- external communication
- production configuration changes
- destructive filesystem changes
- reading known secret-like files
- sending sensitive local context to cloud models

### Model context pack

The **model context pack** is built from mission `context.json` / files under policy, with optional workspace notes only when `include_workspace_notes: true` in `context-diet.yaml`. It applies size limits and can omit or flag **stale** files (content hash or mtime differs from attach time). It does not replace `context.md`; it is a bounded view for model calls.

Packs are classified for sensitivity using the same path heuristics as `@` attach and text heuristics used for workspace notes (API keys, private key blocks, common token patterns). The ledger records `context.pack_built` with sizes and `sensitiveContextIncluded`.

When `cloud_model_sensitive_context` is **`allow`**, model planning may attach the pack to the router input and sets `sensitiveContextIncluded` to match that classification.

When it is **`ask`**, the planner still builds the pack (same as allow) so an approval can cover sending it to a networked provider. The router creates a pending approval (**tool** `narthynx.model.sensitive_context`) before the first networked call with sensitive context; after `narthynx approve <id>`, the next model call for the same task reuses that consent once and marks it executed. If **`cloud_model_sensitive_context` is `block`**, the pack is not attached to planning input.

Future features may add more typed workflows for some of the actions in this document, but only with explicit policy, approval, ledger, and honest rollback/checkpoint behavior.

## Shell And Git Connectors

Phase 11 shell and Git connectors preserve the same safety contract:

- `shell.run` is typed, approval-gated, uses `shell: false`, blocks command chaining and shell metacharacters, rejects known destructive patterns, and bounds `cwd` to the workspace.
- `git.diff` and `git.log` are read-only. They should report repository failures honestly instead of fabricating clean output.
- Shell output is captured as mission artifacts and ledger events. Shell actions are not treated as reversible.

## Model providers and hybrid routing

Phase 12 adds model routing without weakening local-first defaults:

- `stub` is the default provider and never uses network or API keys.
- OpenAI-compatible endpoints are opt-in via environment variables (`NARTHYNX_MODEL_PROVIDER=openai-compatible`, base URL, key, model) **or** per-task entries in optional `.narthynx/model-routing.yaml`.
- **Loopback** OpenAI-compatible base URLs (for example `http://127.0.0.1:11434/v1`) are treated as **local inference**: they do not require `allow_network: true` and do not trigger sensitive-context cloud approval by themselves.
- **Non-loopback** URLs are **networked**: they require `allow_network: true`, honor `cloud_model_sensitive_context`, and appear in policy enforcement like any cloud route.
- Optional **YAML routing** maps each model task (`planning`, `final_report`, etc.) to a `primary` endpoint and optional **single** `fallback` (used only for timeout / transport / HTTP error class failures — not for invalid JSON from the model).
- Optional **budgets** in `model-routing.yaml` cap estimated mission token totals and recorded cost: `on_exceed: fail_closed` rejects further calls; `on_exceed: downgrade_stub` forces the stub provider when a cap is reached.
- API keys are read from environment variables (per-endpoint `api_key_env` or `NARTHYNX_OPENAI_API_KEY`) and must not be written to ledgers, reports, replay output, or mission files.
- Every successful model call records `model.called` and `cost.recorded` events. `model.called.details.routing` records endpoint ids, whether a fallback was used, consent approval linkage, and budget downgrade when applicable.

## Executor Boundary

Phase 13 runs only the deterministic MVP graph slice. It may use read-only local tools, request approval for the report artifact step, resume after approval or denial, and complete with a deterministic report.

It must not run arbitrary shell commands, choose tools from model output, send external communication, call networks, or write arbitrary user files.

## Public Documentation Boundary

Phase 14 examples and public docs must preserve the safety model:

- no live secrets, tokens, private keys, or production data
- no destructive commands
- no fake screenshots or fabricated outputs
- no unsupported autonomy claims
- no instructions that bypass policy, approvals, ledgers, reports, or replay

## Phase 15 Mission Kit Safety

Mission templates, context diet, and proof cards are local-only. Context file attachment uses the same workspace path guard and policy deny patterns as safe filesystem reads, so `.env`, SSH keys, token-like files, and paths outside the workspace remain blocked.

Proof cards are local Markdown artifacts. They are not hosted share links and do not send mission state externally.
