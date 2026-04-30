# Pull Request

## Summary

Describe the change and the phase or mission-runtime capability it supports.

## Mission Runtime Impact

- [ ] Preserves local-first behavior
- [ ] Preserves durable mission state
- [ ] Preserves ledger/replay transparency
- [ ] Preserves approval-gated risk behavior
- [ ] Does not fake completed actions or unsupported capabilities

## Safety Checklist

- [ ] Safety defaults are not weakened
- [ ] No secrets, tokens, private keys, or production data added
- [ ] No post-MVP integrations added without typed schemas, policy behavior, ledger events, and tests
- [ ] Shell, network, external communication, and credential behavior are unchanged or explicitly documented

## Docs and Tests

- [ ] Tests added or updated where behavior changed
- [ ] README/docs/examples updated where user-facing behavior changed
- [ ] CHANGELOG updated

## Verification

List the commands run, for example:

```bash
pnpm test
pnpm build
pnpm lint
pnpm pack --dry-run
```
