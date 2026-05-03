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

## Browser connector (Playwright, Phase 16)

Headless Chromium via **Playwright**. Each tool run uses an **ephemeral** browser (launch, one action, close). All `browser.*` tools are **typed tools**: Zod schemas, ledger events, **`network`** side effect, **`high`** risk, **`requiresApproval: true`**, and continued execution through `runApprovedTool` / `narthynx approve` like `shell.run`.

### Policy (`policy.yaml`)

| Key | Purpose |
| --- | --- |
| `browser` | `block` (default) or `ask`. When `block`, browser tools are denied regardless of `allow_network`. |
| `browser_hosts_allow` | Non-empty list required when `browser: ask` tools are used. URL prefixes (e.g. `https://example.com/`), optional trailing `*` prefix match, or bare hostnames (e.g. `example.com`). Each tool `url` must match. |
| `allow_network` | Must be `true` to **execute** browser tools after approval. |
| `browser_max_navigation_ms` | Playwright navigation and default timeouts (default 30000). |
| `browser_max_steps_per_session` | Reserved for future session reuse. |

**Blocked URL schemes:** `file:`, `javascript:`, `data:` (always denied).

### Tools

| Tool | Input (summary) | Output / artifacts |
| --- | --- | --- |
| `browser.navigate` | `url`, optional `waitUntil` | `title`, `finalUrl` |
| `browser.snapshot` | `url`, optional `maxChars` | Accessibility-style JSON of title, URL, body text; artifact `browser_snapshot` under `artifacts/outputs/` |
| `browser.screenshot` | `url`, optional `fullPage` | PNG; artifact `browser_screenshot` under `artifacts/screenshots/` |
| `browser.click` | `url`, `selector` **or** `role` + `name` | Confirmation |
| `browser.fill` | same + `value` | Confirmation |
| `browser.press` | `url`, `key` (e.g. `Enter`) | Confirmation |

### Install (local runs)

Playwright is an npm dependency; browser binaries are not bundled:

```bash
pnpm exec playwright install
```

### Non-goals

- Autonomous login, 2FA, CAPTCHA solving, or payment flows (use operator handoff).
- Hosted browser grids or cloud browsers.
- Replacing the mission runtime; Narthynx remains a **Mission Agent OS**, not a browser-only automation stack.

## Anti-Goals

Phase 11 does not add mutating Git commands, raw shell strings, or hosted execution. **Phase 11** did not include browser automation; the **browser connector** is a later typed-tool slice (see above).

## Event-to-mission triggers (ingress)

**Triggers** normalize external events and may **`createMission`** from `.narthynx/triggers.yaml` rules; they are **not** Phase 11 typed tools. See [`triggers.md`](triggers.md) for the threat model, CLI (`narthynx triggers`), and the Cockpit GitHub webhook path. Connectors remain the mechanism for **in-mission** tool execution with policy and approvals.

## Phase 12 Model Providers

Model providers are not typed tools; they are routed through `src/agent/model-router.ts` and recorded in each mission ledger.

- Default provider: `stub`, deterministic, local-only, zero cost.
- Optional provider: OpenAI-compatible chat completions through Node `fetch`.
- Required env for cloud provider: `NARTHYNX_MODEL_PROVIDER=openai-compatible`, `NARTHYNX_OPENAI_BASE_URL`, `NARTHYNX_OPENAI_API_KEY`, and `NARTHYNX_OPENAI_MODEL`.
- Cloud calls require `allow_network: true`.
- `/cost` and `narthynx cost <mission-id>` summarize model calls, tokens, estimated cost, and sensitive-context usage.
- Phase 12 only wires model routing into explicit plan generation through `plan --model`; it does not execute missions autonomously.

## Phase 13 Executor Usage

The Phase 13 executor uses connectors only through the typed runtime:

- workspace inspection uses read-only local tools
- Git context uses read-only status-style behavior
- the approval pause uses the existing approval queue
- final reporting uses the existing report artifact path

Browser tools are not used by the default Phase 13 graph; they are available to missions and operators when policy permits.

## Phase 14 Documentation Rules

Connector docs and examples must describe implemented behavior only. Further connectors (for example deeper MCP, GitHub, email, calendar, hosted sync) remain incremental. **Browser automation** is implemented as typed `browser.*` tools with policy and tests (see Browser connector section).

## Phase 15 Mission Kit Is Not A Connector

Templates, context diet, and proof cards are local mission primitives. Mission Kit does not bundle Playwright or headless browser execution; use typed `browser.*` tools when policy allows.
