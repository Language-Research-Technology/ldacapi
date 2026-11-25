# CLAUDE.md

## Agent skills

### Issue tracker

GitHub Issues on `Language-Research-Technology/ldacapi`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Tests and coverage

`pnpm test` fails unless every line and branch of `src/` is covered. Cover new code with a test of the behaviour it exists for, not one written to reach a line. Code no test can reach is either dead (delete it) or only satisfies the types (assert the type instead of guarding). A `/* v8 ignore */` is for the rare line that is neither, and says why.

Entry points (`scripts/*.ts`, `src/index.ts`, `src/worker.ts`) only parse arguments and call code in `src/`. They run as their own process, which coverage can't see, so they are left out of it; logic put there is unmeasured.

## Database migrations

A migration that creates or changes arocapi's models (`prisma/arocapi`, symlinked from the arocapi package) is named after the arocapi version: after an arocapi upgrade that changes the models, run `pnpm db:migrate --name arocapi-<version>`. Name migrations for our own models (`prisma/models`) after what they change.

## Upgrading arocapi

After any arocapi upgrade, recheck the README's links to arocapi's docs (arocapi.crate-works.org is unversioned): each page and anchor should still exist and still say what the README relies on.
