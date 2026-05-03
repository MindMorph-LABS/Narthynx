# Contributing to Narthynx

Narthynx is a local-first Mission Agent OS. Contributions should preserve the mission-native product identity: durable missions, transparent ledgers, approval-gated actions, checkpoints, artifacts, reports, and replayable execution.

## Local Setup

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Run the CLI from source:

```bash
pnpm narthynx --help
pnpm narthynx init
pnpm narthynx doctor
```

## Before You Open a PR

- Read `Narthynx_Codex_AGENTS.md`.
- Keep the change inside the current phase or explicitly documented scope.
- Preserve local-first behavior.
- Do not hide failures or fake completed actions.
- Do not weaken safety defaults.
- Add or update tests for behavior changes.
- Update docs when commands, policy, ledger events, reports, replay, tools, or examples change.
- Keep examples free of secrets, production data, destructive commands, and unsupported autonomy claims.

## Branches and Commits

Use focused branches and small commits when possible. A good PR should explain:

- what mission-runtime capability changed
- what safety behavior changed, if any
- how ledger, replay, reports, approvals, or artifacts are affected
- which commands verified the change

## Merging into `main`

The default branch **`main` is branch-protected** on GitHub (direct pushes and non-PR updates are rejected). **Always merge via GitHub:**

1. Push your branch to `origin` (feature branch, or a one-off integration branch such as `feat/merge-*` if you already merged locally).
2. Open GitHub **Compare / pull request** from your branch → `main` (for example: `https://github.com/<org>/<repo>/compare/main...<your-branch>?expand=1`).
3. Create the PR and **merge on GitHub** after review and checks (use the repository’s required merge method).

Do not rely on `git push origin main` or automating merge without a PR unless repository settings explicitly allow it.

## Phase Discipline

The MVP through Phase 14 is implemented. Phase 15 and later work is post-MVP and should not be smuggled into unrelated changes.

Post-MVP integrations such as GitHub, email, calendar, hosted sync, or team collaboration must follow the same bar: typed tools or services with schemas, policy, approval behavior, ledger events, tests, and honest documentation. The **browser connector** (Playwright) and **MCP (stdio)** are implemented under that bar; extending them (for example remote MCP transports, browser session reuse, or CDP) must preserve those guarantees.

## Testing Expectations

Run the checks that match the change:

```bash
pnpm test
pnpm build
pnpm lint
pnpm pack --dry-run
```

For CLI behavior, include the command you ran and the relevant output. For mission-runtime changes, verify restart-safe persistence where applicable.

## Documentation Expectations

Update docs when changing:

- CLI commands or slash commands
- mission schema or graph behavior
- ledger event families
- tools or connector behavior
- policy and approval behavior
- reports, replay, cost summaries, or artifacts
- public examples or release instructions

Public docs should be honest about current behavior and clear about post-MVP limitations.

## Security

Do not include live credentials, private keys, tokens, `.env` contents, production data, or sensitive logs in issues, PRs, examples, fixtures, ledgers, reports, or replay output.

Report suspected vulnerabilities through `SECURITY.md` rather than public issues.
