# Release Checklist

Use this checklist before tagging or publishing a Narthynx release.

## Clean Clone

- [ ] Clone the repository into a fresh directory.
- [ ] Confirm Node.js 20+ and pnpm 10+ are available.
- [ ] Run `pnpm install`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm pack --dry-run` and confirm expected files are included.

## MVP Demo Flow

- [ ] Run `pnpm narthynx init`.
- [ ] Run `pnpm narthynx doctor`.
- [ ] Run `pnpm narthynx mission "Prepare launch checklist"`.
- [ ] Run `pnpm narthynx plan <mission-id>`.
- [ ] Run `pnpm narthynx run <mission-id>` and confirm it pauses for approval.
- [ ] Run `pnpm narthynx approve <approval-id>`.
- [ ] Run `pnpm narthynx resume <mission-id>` and confirm completion.
- [ ] Run `pnpm narthynx report <mission-id>`.
- [ ] Run `pnpm narthynx replay <mission-id>`.
- [ ] Run `pnpm narthynx timeline <mission-id>`.

## Denial Path

- [ ] Create a second mission.
- [ ] Run it until approval.
- [ ] Run `pnpm narthynx approve <approval-id> --deny`.
- [ ] Run `pnpm narthynx resume <mission-id>`.
- [ ] Confirm the report and replay record the denial honestly.

## Documentation

- [ ] README quickstart matches the current CLI.
- [ ] `docs/roadmap.md` phase status matches the release.
- [ ] `docs/mission-spec.md`, `docs/safety-model.md`, `docs/cli-ux.md`, and `docs/connectors.md` describe implemented behavior only.
- [ ] Examples are copyable, local-first, and free of secrets.
- [ ] Screenshot or GIF placeholders are clearly labeled unless replaced by real captures.
- [ ] `CHANGELOG.md` includes the release.

## Safety Review

- [ ] No docs suggest bypassing policy, approvals, ledgers, reports, or replay.
- [ ] No examples include destructive commands, live credentials, private keys, tokens, `.env` contents, or production data.
- [ ] Shell behavior is described as typed and approval-gated.
- [ ] Network/model behavior is described as opt-in and policy-gated.
- [ ] Post-MVP features are not described as implemented.

## GitHub

- [ ] Issue templates route security issues away from public reports.
- [ ] Pull request template asks for safety, docs, tests, and mission-runtime impact.
- [ ] CI is green on the release branch.
