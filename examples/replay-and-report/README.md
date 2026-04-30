# Replay and Report Example

This example focuses on the difference between raw ledger history and narrative replay.

## Goal

Create a mission, run it through the bounded executor, and compare `timeline`, `replay`, and `report`.

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm narthynx init
pnpm narthynx mission "Summarize this repository's mission runtime"
pnpm narthynx run <mission-id>
pnpm narthynx approve <approval-id>
pnpm narthynx resume <mission-id>
```

Compare the durable views:

```bash
pnpm narthynx timeline <mission-id>
pnpm narthynx replay <mission-id>
pnpm narthynx report <mission-id>
```

## What To Look For

- `timeline` is the raw append-only ledger view.
- `replay` is the human-readable mission story reconstructed from ledger events.
- `report` is the durable Markdown artifact for the completed mission.

## Safety Notes

Replay and reports are read-only views over persisted mission state. They should not mutate mission state or invent events that are missing from the ledger.
