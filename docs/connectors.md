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

## MCP connector (stdio)

MCP integration uses the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) client over **stdio** (spawned subprocess per operation). It is a **capability multiplier**: the child process may perform network, filesystem, or credential access even though Narthynx only sees stdin/stdout.

### Workspace configuration

- **`.narthynx/mcp.yaml`** — declares MCP servers (`id`, `command`, `args` without a shell, optional `cwd` under the workspace root, optional `env` **names** whose values are taken from the parent process environment, `timeoutMs`, `maxOutputBytes`, optional `tools_allow` / `tools_deny`).
- **`policy.yaml`** — `mcp: block | ask` (default on new workspaces: `block`), optional `mcp_servers_allow` (when set, only those server ids may be used; `mcp.servers.list` is still allowed to help operators inspect config), optional `mcp_max_concurrent_sessions` (reserved; v1 uses one-shot sessions).

### Typed tools

| Tool | Role |
| --- | --- |
| `mcp.servers.list` | Lists configured servers, policy allow flag, and cached `tools/list` metadata paths under `.narthynx/.cache/mcp-tools/`. |
| `mcp.tools.list` | Returns tools for a server (cache ~5 minutes, or `refresh: true` for a live handshake; refresh is blocked in **`safe`** policy mode). |
| `mcp.tools.call` | Calls `tools/call` with `serverId`, `name`, and `arguments`. **High risk**, `external_comm` side effect: requires approval (or policy block), honors `external_communication`, bounded argument JSON size, and may write `mcp_tool_output` artifacts when results exceed `maxOutputBytes`. |

Operator CLI: `narthynx mcp list` shows the same server/cache snapshot. `narthynx doctor` validates `mcp.yaml` and checks allowlist coherence when `mcp` is not `block` and `mcp_servers_allow` is set.

## GitHub connector (REST, Phase 18)

Outbound **GitHub REST API** from inside a mission via typed `github.*` tools (`@octokit/rest`). This is separate from **triggers** ([`triggers.md`](triggers.md)): webhooks only create missions; they do not call these tools.

### Auth and workspace files

- **`GITHUB_TOKEN` or `GH_TOKEN`** in the process environment (fine-grained or classic PAT). Never store tokens in mission files.
- **`.narthynx/github.yaml`** (optional): `defaultOwner`, `repos_allow` (`owner/repo` list), `baseUrl` for **GitHub Enterprise** (e.g. `https://github.example.com/api/v3`), `timeoutMs`, `maxResponseBytes`.
- **`policy.yaml`**: `github: block | ask` (default **`block`**), optional `github_repos_allow`. When both policy and `github.yaml` set allowlists, the **effective** allowlist is their **intersection** (if both non-empty); most restrictive wins.

Tools use the **`external_comm`** side effect: you need `external_communication: ask` (or looser) for API calls, in addition to `github: ask`.

### Tools (v1)

| Tool | Risk | Approval | Notes |
| --- | --- | --- | --- |
| `github.repos.get` | low | no | Repository metadata |
| `github.issues.get` / `github.issues.list` / `github.issues.listComments` | low | no | Pagination capped in schemas |
| `github.pulls.get` / `github.pulls.list` | low | no | |
| `github.pulls.listFiles` | medium | no | |
| `github.issues.create` | high | yes | Creates an issue |
| `github.issues.createComment` | high | yes | |

Outputs use `{ data, artifactPath?, truncated, resultBytes }`. Large JSON spills to an artifact typed `github_api_response` when over `maxResponseBytes`.

`narthynx doctor` validates `github.yaml`, checks allowlist intersection when both sources define lists, and verifies a token is set when `github` is not `block`.

### PAT scopes (guidance)

- Read repos/issues/PRs: at least **read-only** scopes for the target repositories.
- Create issues/comments: **`issues` write** (or Fine-grained “Issues” read/write on the repo).

## Anti-Goals

Phase 11 does not add mutating Git commands, raw shell strings, or hosted execution. **Phase 11** did not include browser automation, MCP, or the GitHub API connector; those are later typed-tool slices (see above).

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

Connector docs and examples must describe implemented behavior only. Further connectors (email, calendar, hosted sync, and deeper browser/MCP/GitHub transports) remain incremental. **Browser**, **MCP (stdio)**, and **GitHub REST** are implemented as typed tools with policy, tests, and docs in this file.

## Phase 15 Mission Kit Is Not A Connector

Templates, context diet, and proof cards are local mission primitives. Mission Kit does not bundle Playwright, MCP servers, GitHub clients, or headless execution; use typed `browser.*`, `mcp.*`, or `github.*` tools when policy allows.
