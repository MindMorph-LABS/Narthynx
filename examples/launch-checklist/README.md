# Launch Checklist Example

This example walks through the public MVP flow with a harmless local mission. It does not use network calls, secrets, destructive commands, or arbitrary autonomous writes.

## Goal

Create and run a mission that prepares a launch checklist from the local repository context.

## Commands

From the repository root:

```bash
pnpm install
pnpm build
pnpm test
pnpm narthynx init
pnpm narthynx doctor
pnpm narthynx mission "Prepare my launch checklist from this repo"
```

Copy the mission ID printed by `mission`, then inspect and run it:

```bash
pnpm narthynx plan <mission-id>
pnpm narthynx run <mission-id>
```

The executor should complete read-only steps and pause for approval before the report artifact step. Copy the approval ID from the output:

```bash
pnpm narthynx approve <approval-id>
pnpm narthynx resume <mission-id>
```

Inspect the durable output:

```bash
pnpm narthynx report <mission-id>
pnpm narthynx replay <mission-id>
pnpm narthynx timeline <mission-id>
```

## Expected Shape

- Mission state moves from `created` to `waiting_for_approval`, then to `completed` after approval and resume.
- The ledger records mission creation, plan creation, node progress, tool calls, approval outcome, artifact creation, and completion.
- The report is written under `.narthynx/missions/<mission-id>/artifacts/report.md`.
- Replay shows the mission story in human-readable order.

## Safety Notes

This flow uses the deterministic Phase 13 executor. It does not run shell commands, call model providers, use network access, or write arbitrary workspace files.
