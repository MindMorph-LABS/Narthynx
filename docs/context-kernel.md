# Frontier context kernel (F19)

Phase 19 compiles the same durable mission sources you already trusted (context index files, workspace notes when enabled, governed memory reads) into a versioned **`ContextPacket`**: structured items, exclusions, fingerprints, optional git-diff snippets, **`packText`**, and deterministic ledger + artifact trails.

Philosophy: **explain** what was eligible, what spilled for budget/policy reasons, and what must stay local—not a silent compression black box.

## Data model (`src/context/types.ts`)

- **`ContextItem`**: `kind` (`note` | `file` | `workspace_note` | `memory`), `included`, `reasonIncluded` / `omitReason`, `sensitivity`, routing hints (`routingNote`), byte/token-ish telemetry (`originalBytes`, `includedBytes`, `compressionRatio`, `contentSha256`, `sourceMode`).
- **`ContextPacket`**: `id` (`cpkt_…`), `schemaVersion`, `missionId`, `trigger` (`planning` | `interactive` | `cli` | `manual`), `items`, `excluded`, `totals`, `packText`.
- **`ExcludedItem`** blocks before budget classification (filesystem deny/unreadable/memory-off/git diff failure semantics).

Schemas are enforced with **Zod** for artifacts.

## Ledger + persistence

Persisting emits (in order):

1. **`context.packet_logged`** — summary fields in `details` (`packet_id`, caps, omission counts by reason, exclusion counts).
2. **`context.pack_built`** — continuity with older tooling (`memory_item_ids`, overlapping size fields).

The full JSON snapshot is mirrored at `artifacts/context-packets/<packet_id>.json` when persistence is enabled.

## CLI (`narthynx context`)

- `narthynx context <mission-id>` — human context summary plus the last persisted **`context.packet_logged`** hint (if present).
- `narthynx context diet <mission-id>` — prints effective `context-diet.yaml` plus a **`persist:false`** kernel manifest (`renderWhy`).
- `narthynx context inspect <packet-id> [--mission <id>]` — load the artifact manifest for inspection.
- `narthynx context <mission-id> --pack` — previews a compiled pack **without ledger writes**.

## Slash (interactive shell)

See `/help` Context flags:

- `/context why [mission]` — persisted packet manifest when possible; falls back to a dry-run rebuild.
- `/context diet [mission]` — YAML dump + manifest (dry-run).

## Git diff inclusion

`context-diet.yaml`:

- **`file_context_mode`**: `full` | `diff` | `auto`
- **`git_diff_max_chars`**: bounds diff capture

Tracked paths invoke a local `git` subprocess (outside the typed tool-runner). Explicit `diff` mode records an exclusion when fallback to truncated file snapshots is necessary.

## Model planner routing surface

Planning forwards `modelContextPack` enriched with **`contextPacketId`** and sanitized **`exclusionCounts`** alongside existing totals/text. Sensitive-cloud consent tooling receives these **counts and ids—not raw secrets**.

## Limits (explicit)

Relevance ranking is overlap on mission goal/title tokens—**no embedding model**.

Branch-wide summarization beyond diff snippets is **optional/future**.

Large tool spills are **not** auto-ingested beyond documented hooks.
