# CLAUDE.md

## Agent skills

### Issue tracker

GitHub Issues on `Language-Research-Technology/ldacapi`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Database migrations

A migration that creates or changes arocapi's models (`prisma/arocapi`, symlinked from the arocapi package) is named after the arocapi version: after an arocapi upgrade that changes the models, run `pnpm db:migrate --name arocapi-<version>`. Name migrations for our own models (`prisma/models`) after what they change.
