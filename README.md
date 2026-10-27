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
  index, used by arocapi's entity and file routes) and, as one search
  document per entity, into arocapi's OpenSearch search backend
  (`src/indexer/`). The search fields are declared in `src/indexer/search.ts`.
- **Admin pages**: server-rendered pages at `/admin/` on their own origin,
  where admins, who sign in through our own OIDC provider, see and rebuild or
  delete indexes (`src/admin/`).
- **Access control**: licences are checked against REMS, with sign-in through
  an OIDC provider (`src/auth.ts`, `src/routes/auth.ts`).
- **File downloads**: short-lived signed URLs that stream files out of OCFL
  (`src/routes/file.ts`).

## Getting started

You need Node.js 24 (24.18 or later), [pnpm](https://pnpm.io/) and Docker.

```sh
pnpm install
docker compose up -d --wait   # Postgres, OpenSearch and Oni
pnpm bootstrap                # migrate the database, seed OCFL from test-data, index
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

| Script               | Does                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| `pnpm dev`           | Run the API, restarting on changes, and rebuild the admin pages' stylesheet      |
| `pnpm build`         | Build the admin pages' stylesheet (run before deploying)                         |
| `pnpm test`          | Run the tests (needs `docker compose up`)                                        |
| `pnpm lint`          | Biome, Knip and TypeScript                                                       |
| `pnpm bootstrap`     | `db:deploy`, `seed` and `index` in one go                                        |
| `pnpm seed [dir]`    | Import each crate folder in `dir` (default `test-data`) into the OCFL repository |
| `pnpm index`         | Rebuild both indexes from the OCFL repository                                    |
| `pnpm generate-keys` | Print new `OIDC_SIGNING_KEYS` and `OIDC_COOKIE_KEYS` for `.env`                  |
| `pnpm db:migrate`    | Create and apply a migration after a schema change                               |
| `pnpm db:deploy`     | Apply pending migrations                                                         |
| `pnpm db:reset`      | Drop and recreate the dev database                                               |
| `pnpm db:console`    | Open `psql` on the dev database                                                  |

## Test data

Each folder in `test-data/` is one RO-Crate. `pnpm seed` imports them into the
OCFL repository at `storage/ocfl` (gitignored), and re-running it only adds a
new OCFL version for crates that changed. Run `pnpm index` afterwards.

The indexer skips a crate that has no metadata licence (the `license` of
`ro-crate-metadata.json`) or no content licence (the `license` of the root
dataset) unless `DEFAULT_METADATA_LICENSE` or `DEFAULT_LICENSE` is set.

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
| `OCFL_ROOT`                                                | `storage/ocfl`                                        |
| `OCFL_SCRATCH`                                             | `scratch` beside `OCFL_ROOT`                          |
| `LDACAPI_PORT`                                             | `8080`                                                |
| `LDACAPI_HOST`                                             | `localhost`                                           |
| `LDACAPI_MAX_PARAM_LENGTH`                                 | `500`                                                 |
| `LOG_LEVEL`                                                | `debug` in development, otherwise `info`              |
| `ENTITY_INDEX`                                             | `entities`                                            |
| `DEFAULT_LICENSE`, `DEFAULT_METADATA_LICENSE`              | none                                                  |
| `REMS_USER`, `REMS_KEY`, `REMS_ENDPOINT`, `ENROLLMENT_URL` | none                                                  |
| `OIDC_UPSTREAM_ISSUER`                                     | none (sign-in is off)                                 |
| `OIDC_UPSTREAM_CLIENT_ID`, `OIDC_UPSTREAM_CLIENT_SECRET`   | none                                                  |
| `OIDC_ISSUER`                                              | `http://localhost:8080`                               |
| `OIDC_CLIENTS`                                             | `[]`                                                  |
| `OIDC_SIGNING_KEYS`, `OIDC_COOKIE_KEYS`                    | generated at each start outside production            |
| `ADMIN_ORIGIN`                                             | `http://admin.localhost:8080` outside production      |
| `ADMIN_USERS`                                              | none (nobody is an admin)                             |

With `NODE_ENV=production`, `DATABASE_URL`, `OPENSEARCH_URL` and `OCFL_ROOT`
have no defaults and must be set.

### Sign-in

The API is an OIDC provider with `OIDC_ISSUER`, its public origin, as the
issuer. It signs users in at the upstream provider, an external OIDC provider
such as CILogon or AAF. Sign-in is on when `OIDC_UPSTREAM_ISSUER` is set;
without it there is no discovery or `/oauth/*` route, and every request is
anonymous.

- `OIDC_UPSTREAM_ISSUER`, `OIDC_UPSTREAM_CLIENT_ID` and
  `OIDC_UPSTREAM_CLIENT_SECRET` are the upstream provider's issuer URL and the
  client registered there. Register `<OIDC_ISSUER>/oauth/callback` (e.g.
  `http://localhost:8080/oauth/callback`) as that client's redirect URI.
- `OIDC_ISSUER` is an origin, with no path. It is required, and must be https,
  in production when sign-in is on.
- `OIDC_CLIENTS` lists the apps allowed to get tokens, at least one when
  sign-in is on, as a JSON array of
  `client_id`, `redirect_uris`, and optionally `post_logout_redirect_uris` and
  `client_secret`. Clients without a secret are public and must use PKCE. For
  the Oni in Docker Compose:

  ```sh
  OIDC_CLIENTS='[{"client_id":"oni","redirect_uris":["http://localhost:3000/auth/callback"],"post_logout_redirect_uris":["http://localhost:3000/"]}]'
  ```

- `OIDC_SIGNING_KEYS` is a JWKS, `{"keys":[…]}`, of private RSA keys that sign
  our tokens; each needs a `kid` and `alg` `RS256`. `OIDC_COOKIE_KEYS` is a
  comma-separated list of secrets, each at least 32 characters, that sign the
  provider's cookies. The first key in each signs, and the rest only verify.
  Both are required in production when sign-in is on. Elsewhere, if unset,
  the API generates throwaway keys at each start, so every restart signs
  everyone out. Generate them with `pnpm generate-keys`, which prints both
  lines ready for `.env`. In development, run it once so `pnpm dev` restarts
  keep you signed in:

  ```sh
  pnpm generate-keys >> .env
  ```

To rotate the signing key, put a new one (from `pnpm generate-keys`) first in
`OIDC_SIGNING_KEYS`, keep the old one second, and deploy. Remove the old one
after 15 minutes, once the access tokens it signed have expired. Rotate cookie
keys the same way, removing the old one after the 30-day session lifetime, or
straight away if everyone signing in again is acceptable.

At startup the API fetches the upstream provider's discovery document, and
logs an error naming `OIDC_UPSTREAM_ISSUER` if it can't. It keeps running and
tries again at the next sign-in.

Discovery is at `<OIDC_ISSUER>/.well-known/openid-configuration`. Oni's
`api.oidc.endpoint` is `OIDC_ISSUER` and its `api.oidc.clientId` is a
`client_id` in `OIDC_CLIENTS`.

### Admin pages

The admin pages are at `<ADMIN_ORIGIN>/admin/`. `ADMIN_ORIGIN` is an origin,
with no path, such as `https://admin.example.org`, and must differ from
`OIDC_ISSUER`: crate files are served on the API's origin with their own
content type, so HTML or SVG in a crate could run script there, and a separate
origin keeps that away from admin. It defaults to `http://admin.localhost:8080`
outside production, which browsers resolve to this machine; in production it
must be https. The admin pages are on only when sign-in is and `ADMIN_ORIGIN`
is set; otherwise startup logs a warning and `/admin/` is not found. On the
admin origin only `/admin/` is served, and on any other host `/admin/` is not
found. Visiting them signs you in through our own OIDC provider, as Oni does,
so you need no other password or key.

The admin pages run in the API's process, so the reverse proxy must route the
admin hostname to the API too, and pass the browser's `Host` header through
unchanged: the API tells the two origins apart by `Host`, not by
`X-Forwarded-Host`.

`ADMIN_USERS` is a comma-separated list of the `sub`s of admins. Anyone else who
signs in gets a page saying they aren't an admin, showing the `sub` to add.
Every request checks the list, so removing someone takes effect as soon as the
API restarts. An admin session lasts 8 hours, and signing out of the admin
pages also ends the session at our provider.

The crates page shows every crate's state in each index, and can index,
reindex or delete one crate's indexes, or index or delete all of them.
Indexing a crate also indexes the crates under it. A crate that is already
indexed needs reindexing, and indexing is refused while a delete is in
progress. The page reloads itself until the work finishes.

The admin pages are a client of our provider that needs no entry in
`OIDC_CLIENTS`; their client secret and session keys are derived from
`OIDC_COOKIE_KEYS`, so they rotate with it.

The admin pages are styled with [Tailwind](https://tailwindcss.com/), built by
`@tailwindcss/cli` from `src/admin/admin.css`, which scans the admin module's
templates, into `src/admin/public/admin.css`. That file is not checked in: a
deploy must run `pnpm build` to create it, and `pnpm dev` rebuilds it as you
edit the templates.

## Database

The schema is managed with Prisma migrations in `prisma/migrations`. arocapi
ships its models, linked in through the `prisma/arocapi` symlink (it resolves
once `pnpm install` has run). When an arocapi upgrade changes them, create a
migration named after the arocapi version:

```sh
pnpm db:migrate --name arocapi-<version>
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
