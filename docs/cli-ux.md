# CLI UX

Narthynx is a local-first Mission Agent OS. The CLI should feel fast, readable, and mission-native: users operate durable missions, not a hidden chat loop.

## Interactive Mode

Running `narthynx` with no arguments opens interactive mode.

```txt
Narthynx interactive
Local-first Mission Agent OS. Persistent missions. Approval-gated actions. Replayable execution.
Type /help for commands or /exit to leave.
Narthynx  mode: Ask  mission: none  state: none  risk: none  model: stub
nx>
```

After selecting or creating a mission, the prompt shows the active mission:

```txt
Narthynx  mode: Ask  mission: m_...  state: created  risk: low  model: stub
nx:m_...>
```

The current mission is session-local. It is not persisted as hidden state.

## Slash Commands

Interactive mode supports:

```txt
/mission <goal|mission-id>
/mission
/missions
/plan [mission-id] [--model]
/run [mission-id]
/timeline [mission-id]
/tool [mission-id] <tool-name> --input <json>
/approve [approval-id] [--deny] [--reason <text>]
/pause [mission-id]
/resume [mission-id]
/rewind <checkpoint-id> [mission-id]
/report [mission-id]
/replay [mission-id]
/cost [mission-id]
/policy
/tools
/doctor
/help
/exit
/quit
```

Commands that accept `[mission-id]` use the current mission when the argument is omitted.

`/run` executes the bounded Phase 13 mission executor slice. It advances the deterministic graph, runs read-only local tools, pauses for approval on the report artifact write, and resumes after `/approve` plus `/resume`.

## Safety Boundaries

Interactive mode is a wrapper over existing typed runtime services. It does not introduce raw shell strings, automatic network calls, external communication, or hidden state mutations.

`/plan --model` is explicit. With no provider environment variables, it uses the local deterministic stub provider and records model/cost ledger events. Cloud providers require provider env vars plus `allow_network: true`.

Shortcuts:

```txt
! <command>  requests approval for shell.run
@ <path>     reserved for a future context workflow
# <note>     reserved for a future memory workflow
```

`! <command>` creates a typed `shell.run` approval for the current mission. The command does not execute until the user approves it through `/approve <approval-id>` or `narthynx approve <approval-id>`.

The Phase 13 executor does not use `!` or shell tools. It only uses deterministic read-only steps plus the approval-gated report artifact path.

`/policy` is read-only. Policy edits need a future typed update workflow so safety defaults are not weakened casually.

## Error Handling

Failures must be copyable and specific:

- Missing current mission tells the user to run `/mission <goal>` or `/mission <mission-id>`.
- Missing workspace tells the user to run `narthynx init`.
- Approval denial records the denial and does not execute the action.
- Ctrl+C exits without pretending any command succeeded.
