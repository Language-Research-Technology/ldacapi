# ldacapi

The [Language Data Commons of Australia](https://www.ldaca.edu.au/) (LDaCA)
RO-Crate API. It serves RO-Crates over the
[RO-Crate API specification](https://ro-crate-api.crate-works.org/), with
[Oni](https://github.com/crate-works/oni) as its web front end.

## How it fits together

The core API (entities, files, search, RO-Crate metadata) comes from
[arocapi](https://github.com/Language-Research-Technology/arocapi), which this
app mounts as a Fastify plugin. ldacapi adds what LDaCA needs on top:

- **OCFL storage**: crates live in an [OCFL](https://ocfl.io/) repository on
  disk (`src/ocfl.ts`).
- **Indexing**: crates are read from OCFL into the database (the structural
  index, used by arocapi's entity and file routes) and into OpenSearch (the
  search index) (`src/indexer/`).
- **Admin API**: list, rebuild and delete indexes (`src/routes/admin.ts`).
- **Access control**: licences are checked against REMS, with sign-in through
  an OIDC provider (`src/auth.ts`, `src/routes/auth.ts`).
- **File downloads**: short-lived signed URLs that stream files out of OCFL
  (`src/routes/file.ts`).

## Getting started

You need Node.js 24 (24.18 or later), [pnpm](https://pnpm.io/) and Docker.

```sh
pnpm install
docker compose up -d   # Postgres, OpenSearch and Oni
pnpm bootstrap         # migrate the database, seed OCFL from test-data, index
pnpm dev
```

| Service    | URL                                                   |
| ---------- | ----------------------------------------------------- |
| API        | <http://localhost:8080/api>                           |
| Oni        | <http://localhost:3000>                               |
| OpenSearch | <http://localhost:9200>                               |
| Postgres   | `postgresql://ldacapi:ldacapi@localhost:5432/ldacapi` |

No configuration is needed for development. To override a default, copy
`.env.example` to `.env`.

## Scripts

| Script            | Does                                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| `pnpm dev`        | Run the API, restarting on changes                                               |
| `pnpm test`       | Run the tests (needs `docker compose up`)                                        |
| `pnpm lint`       | Biome, Knip and TypeScript                                                       |
| `pnpm bootstrap`  | `db:deploy`, `seed` and `index` in one go                                        |
| `pnpm seed [dir]` | Import each crate folder in `dir` (default `test-data`) into the OCFL repository |
| `pnpm index`      | Rebuild both indexes from the OCFL repository                                    |
| `pnpm db:migrate` | Create and apply a migration after a schema change                               |
| `pnpm db:deploy`  | Apply pending migrations                                                         |
| `pnpm db:reset`   | Drop and recreate the dev database                                               |
| `pnpm db:console` | Open `psql` on the dev database                                                  |

## Test data

Each folder in `test-data/` is one RO-Crate. `pnpm seed` imports them into the
OCFL repository at `storage/ocfl` (gitignored), and re-running it only adds a
new OCFL version for crates that changed. Run `pnpm index` afterwards.

The indexer skips a crate that has no metadata licence (the `license` of
`ro-crate-metadata.json`) or no content licence (the `license` of the root
dataset) unless `DEFAULT_METADATA_LICENSE` or `DEFAULT_LICENSE` is set.

## Admin API

The admin routes need the admin token (`TOKEN_ADMIN`, `1234-1234-1234-1234` in
development) as a bearer token.

```sh
TOKEN=1234-1234-1234-1234

# Index state of every crate, or of one crate
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/admin/index/
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/admin/index/<crateId>

# Re-index everything, or one crate (optionally one index: structural or search)
curl -X POST -H "Authorization: Bearer $TOKEN" 'http://localhost:8080/api/admin/index/?force'
curl -X POST -H "Authorization: Bearer $TOKEN" 'http://localhost:8080/api/admin/index/<crateId>/<index>?force'

# Delete the indexes of one crate
curl -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/admin/index/<crateId>
```

URL-encode crate ids, which are usually URIs.

## Configuration

Configuration comes only from environment variables, validated at startup
(`src/configuration.ts`). `pnpm dev`, `pnpm seed`, `pnpm index` and Prisma
also read `.env` if it exists, without overriding variables that are already
set.

| Variable                                                   | Default                                               |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `NODE_ENV`                                                 | `development`                                         |
| `DATABASE_URL`                                             | `postgresql://ldacapi:ldacapi@localhost:5432/ldacapi` |
| `OPENSEARCH_URL`                                           | `http://localhost:9200`                               |
| `TOKEN_ADMIN`                                              | `1234-1234-1234-1234`                                 |
| `OCFL_ROOT`                                                | `storage/ocfl`                                        |
| `OCFL_SCRATCH`                                             | `scratch` beside `OCFL_ROOT`                          |
| `LDACAPI_PORT`                                             | `8080`                                                |
| `LDACAPI_HOST`                                             | `localhost`                                           |
| `LDACAPI_MAX_PARAM_LENGTH`                                 | `500`                                                 |
| `LOG_LEVEL`                                                | `debug` in development, otherwise `info`              |
| `ENTITY_INDEX`                                             | `entities`                                            |
| `DEFAULT_LICENSE`, `DEFAULT_METADATA_LICENSE`              | none                                                  |
| `REMS_USER`, `REMS_KEY`, `REMS_ENDPOINT`, `ENROLLMENT_URL` | none                                                  |
| `OIDC_ENDPOINT`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`    | none                                                  |

With `NODE_ENV=production`, `DATABASE_URL`, `OPENSEARCH_URL`, `TOKEN_ADMIN`
and `OCFL_ROOT` have no defaults and must be set.

## Database

The schema is managed with Prisma migrations in `prisma/migrations`. arocapi
ships its models, linked in through the `prisma/arocapi` symlink (it resolves
once `pnpm install` has run). When an arocapi upgrade changes them, create a
migration named after the arocapi version:

```sh
pnpm db:migrate --name arocapi-<version>
```

A database created with `prisma db push` (before migrations existed) needs a
one-off baseline before `pnpm db:deploy` will work:

```sh
pnpm exec prisma migrate resolve --applied 20261007004001_arocapi-4.0.1
```

## Tests

`pnpm test` needs Postgres and OpenSearch from `docker compose up`. Each run
creates its own database and search index, and drops them afterwards, so runs
never touch your dev data or each other.

## Working on Oni

Docker Compose runs the published Oni image with `docker/oni/configuration.json`.
Edit that file and run `docker compose restart oni` to change what Oni shows.

To work on Oni's own code, run it from a checkout of
[crate-works/oni](https://github.com/crate-works/oni) with
`ONI_API_ENDPOINT=http://localhost:8080/api` in `.env.local-config.local` and
`pnpm dev:local`. See Oni's README for the details.
