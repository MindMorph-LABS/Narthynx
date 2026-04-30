# Bug Investigation Example

This example uses Narthynx to create a durable investigation mission. It demonstrates local-first planning, read-only inspection, approval pause/resume, report generation, and replay.

## Goal

Track a small bug-investigation workflow without giving the agent unrestricted execution.

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm narthynx init
pnpm narthynx mission "Investigate why the CLI pause command fails for a missing mission"
pnpm narthynx plan <mission-id>
pnpm narthynx run <mission-id>
```

When Narthynx pauses for the report artifact step, choose either path.

Approve:

```bash
pnpm narthynx approve <approval-id>
pnpm narthynx resume <mission-id>
```

Deny:

```bash
pnpm narthynx approve <approval-id> --deny
pnpm narthynx resume <mission-id>
```

Then inspect:

```bash
pnpm narthynx report <mission-id>
pnpm narthynx replay <mission-id>
pnpm narthynx cost <mission-id>
```

## Expected Shape

- Approved runs include the approved report-write outcome.
- Denied runs do not execute the gated write, but still finish honestly with the denial captured.
- Replay and report should make the decision path visible.

## Safety Notes

This example does not ask Narthynx to modify source files or execute shell commands. If you want shell output attached to a mission, use the typed `shell.run` tool and approve it explicitly.
