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

You need Node.js 26 (26.13 or later), [pnpm](https://pnpm.io/) and Docker.

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
| `pnpm ocfl:init`     | Create an empty OCFL repository at `OCFL_ROOT`, unless one exists already        |
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

  ```dotenv
  OIDC_CLIENTS=[{"client_id":"oni","redirect_uris":["http://localhost:3000/auth/callback"],"post_logout_redirect_uris":["http://localhost:3000/"]}]
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
pages also ends the session at our provider, ending on a signed-out page with a
link to sign in again.

The crates page shows every crate's state in each index. It can index,
reindex or delete one crate's indexes, or index, reindex or delete all of them.
An action on a crate covers the crate and the crates under it: those whose id
is the crate's id followed by `/`. A crate that is already indexed needs
reindexing. Indexing is refused while any crate it covers is being deleted,
queued or indexing, deleting is refused while any crate it covers is queued or
indexing, and an action on a crate that isn't in the repository is refused. The page reloads
itself until the work finishes. Each action, accepted or refused, is logged at
`info` with the admin's `sub`.

The admin pages are a client of our provider that needs no entry in
`OIDC_CLIENTS`; their client secret and session keys are derived from
`OIDC_COOKIE_KEYS`, so they rotate with it.

The admin pages are styled with [Tailwind](https://tailwindcss.com/), built by
`@tailwindcss/cli` from `src/admin/admin.css`, which scans the Eta templates in
`src/admin/views/`, into `src/admin/public/admin.css`. That file is not checked in: the
Docker image builds it, other deploys must run `pnpm build`, and `pnpm dev`
rebuilds it as you edit the templates.

## Docker image

The `Dockerfile` builds the API's image: production dependencies only, the
generated Prisma client and the admin pages' stylesheet. It sets
`NODE_ENV=production` and `LDACAPI_HOST=0.0.0.0`, so the API listens on all
interfaces on port 8080, and its healthcheck requests `/api/capabilities` on
`LDACAPI_PORT`. That check touches neither Postgres nor OpenSearch, so it
reports whether the API is serving, not whether they are up.

CI publishes the image to `ghcr.io/language-research-technology/ldacapi` on
every push to `main`, once lint, test and the image's smoke test pass. Each
image is tagged `sha-<short>` with its commit, so you can pin or roll back a
deployment, and `main` moves to the latest. Pull requests build and smoke-test
the image without publishing it.

Put the API's configuration in an environment file, such as `ldacapi.env`, and
start it. Docker keeps quotes in an environment file's values, so don't quote
them. Don't set `LDACAPI_HOST` there: the healthcheck requests `127.0.0.1`, so
the API must keep listening on `0.0.0.0`.

```sh
docker run -d --env-file ldacapi.env -p 8080:8080 -v /srv/ldacapi:/storage \
  ghcr.io/language-research-technology/ldacapi:main
```

Below, `ldacapi` stands for the image, which you can also build yourself with
`docker build -t ldacapi .`.

### One-off commands

The container never migrates the database when it starts. Before a rollout,
apply the migrations once from the new image, so several replicas never race
to migrate:

```sh
docker run --rm --env-file ldacapi.env -v /srv/ldacapi:/storage ldacapi pnpm db:deploy
```

`pnpm ocfl:init` (which creates an empty OCFL repository; the API won't start
without one), `pnpm seed [dir]` (mount `dir` into the container) and
`pnpm index` run the same way, offline. Give them and `pnpm db:deploy` the API's environment file:
Prisma and the scripts load the whole [configuration](#configuration).
`pnpm generate-keys` reads no configuration, so it needs no environment file:

```sh
docker run --rm ldacapi pnpm generate-keys >> ldacapi.env
```

### Storage

The image has no default `OCFL_ROOT`. Mount your storage and set `OCFL_ROOT`
(and `OCFL_SCRATCH`, if you need it elsewhere) to paths inside the container
(above, `OCFL_ROOT=/storage/ocfl`). The API runs as the
image's `node` user, uid 1000, so the OCFL repository must be readable by uid
1000 and the scratch directory writable by it. `pnpm seed` writes to the
repository, so give it write access too when you run it.

## Production with Docker Compose

`deploy/` runs the whole service on one host: [Caddy](https://caddyserver.com/)
in front, Oni, the API, Postgres and OpenSearch. Caddy is the only container
with published ports (80 and 443), and it gets and renews HTTPS certificates
from Let's Encrypt on its own. It serves two hostnames:

| Hostname       | Path                                                      | Goes to                                                      |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `DOMAIN`       | `/api/*`, `/oauth/*`, `/.well-known/openid-configuration` | The API                                                      |
| `DOMAIN`       | `/configuration.json`                                     | Oni's configuration, served by Caddy with `DOMAIN` filled in |
| `DOMAIN`       | everything else                                           | Oni                                                          |
| `ADMIN_DOMAIN` | `/admin/*`                                                | The API's admin pages                                        |

The admin pages need their own hostname, so that script in a crate file can
never run on their origin (ADR 0002). Caddy also serves everything under
`/api/` with `Content-Security-Policy: sandbox`, which gives any HTML or SVG in
a crate file an opaque origin, so its scripts can't reach Oni's sign-in on
`DOMAIN`.

No other container publishes a port, on the host or on localhost, so Postgres,
OpenSearch, the API and Oni are reachable only from within the stack.
OpenSearch's security plugin is off for that reason. Every container runs with
`no-new-privileges`, and the API, Oni and Caddy run with read-only root
filesystems.

### Setting it up

You need Docker with Compose, ports 80 and 443 open, and DNS for both hostnames
pointing at the host. OpenSearch also needs a larger mmap limit on the host:

```sh
echo vm.max_map_count=262144 | sudo tee /etc/sysctl.d/99-opensearch.conf
sudo sysctl --system
```

Storage is a directory on the host, usually an NFS mount, set by `STORAGE_DIR`
in `.env`. The OCFL repository is its `ocfl` directory, and imports are staged
in its `scratch` directory. Both must be in the one mount: OCFL commits an
import by renaming it from scratch into the repository, and a rename can't
cross mounts. The API runs as uid 1000, so the directory must be writable by
uid 1000: on NFS, set the owner on the server or map the export to uid 1000, as
root in the container is squashed. Otherwise `pnpm ocfl:init` fails with
`EACCES: permission denied, mkdir '/storage/ocfl'`. Serving and indexing only
read, so a read-only mount works if you import crates elsewhere.

Caddy's certificates, Postgres and OpenSearch keep their data in `data/`
beside `compose.yaml`. OpenSearch runs as uid 1000 and can't fix its own
directory's owner, so create it first.

Copy `deploy/` to the host, then, in it:

```sh
sudo install -d -o 1000 -g 1000 data/opensearch
cp .env.example .env                  # DOMAIN, ADMIN_DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD, STORAGE_DIR
cp ldacapi.env.example ldacapi.env    # sign-in, admins and the API's other settings
chmod 600 .env ldacapi.env
docker compose run --rm --no-deps api pnpm -s generate-keys >> ldacapi.env
docker compose run --rm api pnpm db:deploy     # create the database's tables
docker compose run --rm api pnpm ocfl:init     # create the empty OCFL repository
docker compose up -d
```

Nothing migrates the database on its own: you run `pnpm db:deploy` when you
install and when you upgrade, after taking a backup.

Register `https://<DOMAIN>/oauth/callback` as the redirect URI at the upstream
provider. Compose sets the API's database, OpenSearch, storage, `OIDC_ISSUER`,
`ADMIN_ORIGIN` and Oni's client in `OIDC_CLIENTS` from `.env`, so leave those
out of `ldacapi.env`. Edit `oni/configuration.json` to change what Oni shows. Its
endpoints use `DOMAIN`, so don't change them.

### Running it

Import crates and index them with the API's image, mounting the directory of
crates read-only:

```sh
docker compose run --rm -v /path/to/crates:/import:ro api pnpm seed /import
docker compose run --rm api pnpm index
```

The stack runs the API's `main` image. To upgrade, back up the database and
`STORAGE_DIR`, then pull the new images, apply any new migrations and restart:

```sh
docker compose exec -T db pg_dump -U ldacapi -Fc ldacapi > ldacapi-$(date +%F).dump
docker compose pull
docker compose stop api
docker compose run --rm api pnpm db:deploy
docker compose up -d
```

To restore the database from a backup, stop the API and run
`docker compose exec -T db pg_restore -U ldacapi -d ldacapi --clean < ldacapi-<date>.dump`.

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
