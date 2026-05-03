# CLI UX

Narthynx is a local-first Mission Agent OS. The CLI should feel fast, readable, and mission-native: users operate durable missions, not a hidden chat loop.

## Interactive Mode

Running `narthynx` with no arguments opens the **interactive mission shell** (readline-based; no heavy TUI dependency).

```txt
NARTHYNX
Local-first Mission Agent OS
Persistent missions. Approval-gated actions. Replayable execution.

Workspace: <cwd>
Policy: ask
Mode: ask
Model: auto
Active mission: none

Type a goal, or use /help.
Narthynx  mode: Ask  mission: none  state: none  policy: ask  model: auto
narthynx ❯
```

### Natural-language goals

If input does **not** start with `/`, `!`, `@`, or `#`, it is treated as a **mission instruction**:

- With no active mission, Narthynx **creates a new mission** from the text, shows the plan graph, and suggests `/run`.
- With an active mission, the text is recorded as a **context note** and the plan is shown again; use `/run` to advance the Phase 13 executor.

For non-TTY scripted tests, interactive mode uses injectable input so test runs do not hang.

### Prompts

- Default: `narthynx ❯`
- Mission selected: `narthynx m_… ❯`
- Mission waiting for approval: `narthynx m_… approval ❯`

Natural language only updates mission YAML/context and the plan view. It does **not** spawn tools or run the executor; use **`/run`** (and approvals) for that.

### Windows, PowerShell, CMD, Git Bash, WSL

Interactive mode uses Node.js `readline`, which works on **Windows 10+** (ConPTY), **PowerShell**, **cmd.exe**, **Git Bash**, and **WSL**. Behavior can vary slightly (notably **Ctrl+C** and **raw keypress** for optional approval shortcuts):

- If single-key approval (`a` / `d` / `p` / `e`) misbehaves, use **`/approve`** with an id from the panel; the prompt also **cancels** on **Esc**, another letter, or a **timeout** so raw mode is never left stuck indefinitely.
- **`/clear`** uses `console.clear()` for broad terminal support.

## Slash Commands

Interactive mode supports:

```txt
/mission <goal|mission-id>
/mission --template <name> [goal]
/mission
/missions
/templates
/plan [mission-id] [--model]
/graph [mission-id]
/run [mission-id]
/mode [ask|plan]
/timeline [mission-id]
/context [mission-id]
/context --note <text>
/context --file <path> --reason <text>
/context [mission-id] --pack
/tool [mission-id] <tool-name> --input <json>
/approve [approval-id] [--deny] [--reason <text>]
/pause [mission-id]
/resume [mission-id]
/rewind <checkpoint-id> [mission-id]
/report [mission-id]
/proof [mission-id]
/replay [mission-id]
/cost [mission-id]
/policy
/tools
/doctor
/clear
/help
/exit
/quit
```

Commands that accept `[mission-id]` use the current mission when the argument is omitted.

`/run` executes the bounded Phase 13 mission executor slice. It advances the deterministic graph, runs read-only local tools, pauses for approval on the report artifact write, and resumes after `/approve` plus `/resume`.

`/graph` prints the mission plan graph (nodes and edges) for the current or named mission.

### Context diet and model pack

`/context` (with no `--note` / `--file`) shows the mission context summary, a **pack budget** line (bytes used versus `pack_max_bytes` from `.narthynx/context-diet.yaml`, defaulting when the file is absent), and any **stale** file or note entries detected since attach time. Use `/context --pack` to print the full derived pack text (still local-only; use for inspection).

Non-interactive parity:

```bash
narthynx context <mission-id>           # summary
narthynx context <mission-id> --pack    # pack body + budget line
narthynx context <mission-id> --pack --json
narthynx context <mission-id> --prune-stale   # drop stale **file** rows from `context.json` and sync mission YAML file list
```

`narthynx doctor` validates `context-diet.yaml` when present. Optional keys include `pack_max_bytes`, `pack_max_estimated_tokens`, `file_truncation` (per-file caps in the pack only), `stale_policy` (`warn` | `omit_from_pack`), and `include_workspace_notes` (default off).

## Approvals

When the executor or a tool needs approval, Narthynx prints an **Approval required** panel with action, mission, risk, and target. You can use slash commands (`/approve …`) or, on a TTY, single keys after the prompt: **a** approve, **d** deny, **p** pause, **e** (edit — not implemented; use deny and re-run).

Nothing approval-gated runs silently.

## Safety Boundaries

Interactive mode is a wrapper over existing typed runtime services. It does not introduce raw shell execution outside the `shell.run` tool and policy.

`/plan --model` is explicit. With no provider environment variables, it uses the local deterministic stub provider and records model/cost ledger events. Cloud providers require provider env vars plus `allow_network: true`.

Shortcuts:

```txt
! <command>  requests approval for shell.run
@ <path>     attach safe file context to the current mission
# <note>     append a context note (mission if selected; otherwise workspace-notes.md under .narthynx/)
```

`! <command>` creates a typed `shell.run` approval for the current mission. The command does not execute until approved.

`@` refuses paths that look sensitive (for example `.env`, `.env.*`, common SSH key names, `*.pem`, `*.key`, `.ssh`).

The Phase 13 executor does not use `!` or shell tools. It only uses deterministic read-only steps plus the approval-gated report artifact path.

`/policy` is read-only. Policy edits need a future typed update workflow so safety defaults are not weakened casually.

`narthynx doctor` includes **`github yaml`**, optional **GitHub token** and **allowlist intersection** checks when GitHub tooling is enabled in policy (see [`connectors.md`](connectors.md)).

## External CLI Flow

The documented Phase 14 demo path should stay copyable:

```bash
pnpm narthynx init
pnpm narthynx mission "Prepare launch checklist"
pnpm narthynx plan <mission-id>
pnpm narthynx run <mission-id>
pnpm narthynx approve <approval-id>
pnpm narthynx resume <mission-id>
pnpm narthynx report <mission-id>
pnpm narthynx replay <mission-id>
```

The denial path is also valid:

```bash
pnpm narthynx approve <approval-id> --deny
pnpm narthynx resume <mission-id>
```

Denied executor approvals do not execute the gated write, but the mission can still finish with the denial recorded in the ledger, report, and replay.

Phase 15 Mission Kit commands are local-only. Templates create ordinary persisted missions, context commands update `context.md` and `context.json`, and proof cards write `artifacts/proof-card.md`.

## Interrupts and exit

- **Ctrl+C** on a non-empty input line cancels the line and redraws the prompt.
- **Ctrl+C** on an empty line with an active mission asks **Exit interactive shell? [y/N]**.
- **Ctrl+C** on an empty line with no mission exits the shell.
- **Ctrl+D** (EOF) closes the shell.
- **`/exit`** leaves interactive mode.

On exit, Narthynx prints a short reminder that mission state is saved and how to resume (`narthynx open <id>` or run `narthynx` again).

## Architecture (Phase 15.5)

The shell is split for future richer renderers:

- [`interactive.ts`](../src/cli/interactive.ts) — loop, signals, approval key handling
- [`input-router.ts`](../src/cli/input-router.ts) — classify input
- [`slash-commands.ts`](../src/cli/slash-commands.ts) — parse and dispatch `/` commands
- [`shortcuts.ts`](../src/cli/shortcuts.ts) — `!` / `@` / `#` helpers and sensitive path checks
- [`session.ts`](../src/cli/session.ts) — session state
- [`prompt.ts`](../src/cli/prompt.ts) — prompt string
- [`renderer.ts`](../src/cli/renderer.ts) — `Renderer` interface
- [`renderers/readline-renderer.ts`](../src/cli/renderers/readline-renderer.ts) — default terminal output via `InteractiveIo` (stdout/stderr). The only direct `console` call is `console.clear()` for `/clear`, matching broad terminal support.

## Error Handling

Failures must be copyable and specific:

- Missing current mission tells the user to run `/mission <goal>` or `/mission <mission-id>`.
- Missing workspace tells the user to run `narthynx init`.
- Approval denial records the denial and does not execute the action.
- Ctrl+C exits without pretending any command succeeded.
- Unknown slash commands are reported on stderr without crashing the shell.

## Public UX Documentation

README snippets, examples, and screenshots should show real terminal output from the current CLI. Placeholder visuals are allowed only when they are clearly labeled as placeholders and do not imply unsupported behavior.
