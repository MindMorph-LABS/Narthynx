# Event-to-mission triggers

Triggers turn **ingress events** (today: **GitHub webhooks** via the Mission Cockpit, or **CLI ingest**) into **durable missions** using declarative rules. They are **not** a second execution path: they call `createMission` (and optional context notes) only. They do **not** auto-run the mission executor or bypass policy and approvals.

## Workspace layout

| Path | Role |
| --- | --- |
| `.narthynx/triggers.yaml` | Rule file (`version: 1`, `rules[]`) |
| `.narthynx/trigger-events.jsonl` | Append-only **Event Memory** (Zod-validated lines) |
| `.narthynx/trigger-dedup.json` | Idempotency index: `dedupKey` → `{ missionId, ruleId, createdAt }` (bounded; see `MAX_DEDUP_ENTRIES` in code) |
| `.narthynx/triggers/inbox/<eventId>.json` | Raw payload copy for replay |

## CLI

```bash
narthynx triggers doctor
narthynx triggers test --fixture path/to/github-payload.json [--source github] [--event issues]
narthynx triggers ingest --source github [--file payload.json] [--event issues]   # or pipe JSON on stdin
narthynx triggers log [--hours 24]
narthynx triggers replay <eventId> [--force]
```

- **doctor** — validates `.narthynx/triggers.yaml`.
- **test** — dry-run: evaluates rules and dedup without creating a mission.
- **ingest** — persists payload, appends the log, creates a mission when a rule matches and dedup allows.
- **log** — prints recent JSONL lines within the time window.
- **replay** — re-reads the stored inbox file for `eventId`; **`--force`** bypasses dedup for operator recovery.

## Rules file (minimal shape)

```yaml
version: 1
rules:
  - id: my-rule
    enabled: true
    source: github
    match:
      event: issues        # GitHub X-GitHub-Event header
      action: opened       # payload.action
      repository: org/repo # substring of repository.full_name
    action:
      type: create_mission
      template: bug-investigation   # optional: built-in template name
      goalTemplate: "Issue {{ issue.number }} — {{ issue.title }}"
      titleTemplate: "{{ rule.id }}"  # optional when not using template
      appendContextNotes:
        - "GitHub issue {{ issue.html_url }}"
    dedupKeyFrom:
      - "{{ rule.id }}"
      - "{{ issue.number }}"
```

Either **`template`** or **`goalTemplate`** is required on `action`.

## HTTP: GitHub webhook (Mission Cockpit)

The Cockpit exposes **`POST /api/triggers/github`**:

- **Authentication**: `X-Hub-Signature-256` HMAC (GitHub standard). **Not** the Cockpit Bearer token.
- **Secret**: set **`NARTHYNX_TRIGGER_GITHUB_SECRET`** in the environment where the server runs (or pass `githubWebhookSecret` when constructing the app in tests).
- **Headers**: GitHub sends `X-GitHub-Event`, `X-GitHub-Delivery`; the engine stores event name for replay.
- **Limits**: request body is capped (**512 KiB**); oversize payloads return **413**. Invalid JSON returns **400**. Invalid signature returns **401**. Missing secret returns **503** (fail closed for automation).

Configure the same secret in the GitHub repo webhook settings.

## Threat model and operations

- **Webhook secrets** are equivalent to CI secrets: rotate on compromise; never log raw secrets or paste them into issues.
- **Signature failures** must be treated as untrusted traffic; the route returns **401** without running mission logic.
- **Payload size and JSON parsing**: large or malicious bodies are rejected early to limit CPU and disk use in the inbox.
- **Trust boundary**: dedup index and JSONL live under `.narthynx/`; anyone with workspace filesystem access can alter them—document this for shared workstations or team repos.
- **LAN exposure**: if you bind the Cockpit on **`0.0.0.0`**, anything on the network can **attempt** delivery; rely on **HMAC verification** and network isolation. Prefer local binding or a reverse proxy with TLS for non-local callers.
- **No silent execution**: triggers only create missions (and optional context). Tool runs, writes, and shell still go through the normal ledger and approval gates when the operator runs the mission.

## Connectors vs triggers

- **Connectors** (Phase 11) are **typed tools** executed inside a mission with schema, policy, and approval behavior.
- **Triggers** are **ingress**: they normalize events and may call **`createMission`**. They are intentionally not modeled as tools.

## Future work (optional)

Additional **adapters** (email, deploy systems, calendar) should normalize into the same internal envelope and call the same engine. For very large dedup maps, consider **SQLite** or another bounded store; the current default is **JSON on disk** aligned with local-first durability elsewhere.
