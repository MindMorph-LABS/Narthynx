# CLI UX

Narthynx is a local-first Mission Agent OS. The CLI should feel fast, readable, and mission-native: users operate durable missions, not a hidden chat loop.

## Phase 10 Interactive Mode

Running `narthynx` with no arguments opens interactive mode.

```txt
Narthynx interactive
Local-first Mission Agent OS. Persistent missions. Approval-gated actions. Replayable execution.
Type /help for commands or /exit to leave.
Narthynx  mode: Ask  mission: none  state: none  risk: none
nx>
```

After selecting or creating a mission, the prompt shows the active mission:

```txt
Narthynx  mode: Ask  mission: m_...  state: created  risk: low
nx:m_...>
```

The current mission is session-local. It is not persisted as hidden state.

## Slash Commands

Phase 10 supports:

```txt
/mission <goal|mission-id>
/mission
/missions
/plan [mission-id]
/timeline [mission-id]
/tool [mission-id] <tool-name> --input <json>
/approve [approval-id] [--deny] [--reason <text>]
/rewind <checkpoint-id> [mission-id]
/report [mission-id]
/replay [mission-id]
/policy
/tools
/doctor
/help
/exit
/quit
```

Commands that accept `[mission-id]` use the current mission when the argument is omitted.

## Safety Boundaries

Interactive mode is a wrapper over existing typed runtime services. It does not introduce raw shell execution, network calls, model providers, external communication, or hidden state mutations.

The future shortcuts are intentionally honest:

```txt
! <command>  reserved for Phase 11 shell.run and not executed
@ <path>     reserved for a future context workflow
# <note>     reserved for a future memory workflow
```

`/policy` is read-only in Phase 10. Policy edits need a future typed update workflow so safety defaults are not weakened casually.

## Error Handling

Failures must be copyable and specific:

- Missing current mission tells the user to run `/mission <goal>` or `/mission <mission-id>`.
- Missing workspace tells the user to run `narthynx init`.
- Approval denial records the denial and does not execute the action.
- Ctrl+C exits without pretending any command succeeded.
