# ldacapi

The [Language Data Commons of Australia](https://www.ldaca.edu.au/) (LDaCA)
RO-Crate API. It serves RO-Crates over the
[RO-Crate API specification](https://ro-crate-api.crate-works.org/), with
[Oni](https://github.com/crate-works/oni) as its web front end.

## How it fits together

The API's routes (entities, files, search, RO-Crate metadata) come from
[arocapi](https://github.com/crate-works/arocapi), which ldacapi mounts as a
Fastify plugin under `/api` (`src/app.ts`). Its
[docs](https://arocapi.crate-works.org/) explain each part; ldacapi
configures them as follows:

- **Storage backend, Content half**: arocapi's
  [`OcflStorage`](https://arocapi.crate-works.org/configuration/storage/#ocflstorage)
  serves crate files from the OCFL repository.
- **Storage backend, Metadata half**: arocapi's
  [`EntityMetaMetadata`](https://arocapi.crate-works.org/configuration/storage/#entitymetametadata)
  serves each entity's virtual crate, built at index time and held in its
  database row ([ADR 0004](docs/adr/0004-entity-metadata-is-a-virtual-crate.md)).
- **Search backend**: arocapi's
  [`OpenSearchBackend`](https://arocapi.crate-works.org/configuration/search/#opensearchbackend),
  with the [fields](https://arocapi.crate-works.org/configuration/search/#fields)
  declared in `src/search-backend.ts`, where `entityType` filters on an
  entity's class URI and the "Record Type" facet, `recordType`, shows a
  readable label for it.
- **Visibility**: every entity is visible to everyone, through arocapi's
  all-visible [visibility filters](https://arocapi.crate-works.org/configuration/visibility/)
  ([ADR 0003](docs/adr/0003-every-entity-is-visible.md)).
- **Access**: arocapi's
  [`LicenceAccess`](https://arocapi.crate-works.org/configuration/access/#access),
  with the licences a user holds looked up in REMS
  ([licence checks against an external authority](https://arocapi.crate-works.org/strategies/access/#licence-checks-against-an-external-authority));
  see [Licences](#licences) (`src/auth.ts`).

ldacapi adds what LDaCA needs on top (terms as in [GLOSSARY.md](GLOSSARY.md)):

- **OCFL repository**: each crate is one [OCFL](https://ocfl.io/) object on
  disk, imported with `pnpm crates:import` (`src/repository/`).
- **Indexing**: `pnpm index`, `pnpm crates:import` and the admin pages ask for index jobs
  (`src/index-queue/`), and a worker (`src/worker.ts`) runs them, building the
  database index (the Entity and File rows arocapi reads) and the search index
  (one search document per entity) from the repository (`src/indexer/`). Jobs
  and each crate's index state are kept in Postgres. Both indexes can be
  rebuilt at any time (see [Indexing](#indexing)).
- **Collections**: an entity's `rootCollection` is the top-level collection
  it sits under, and is empty on a top-level collection
  ([membership](https://arocapi.crate-works.org/concepts/entities/#membership)).
  Indexing finds it by following `pcdm:memberOf` up through the parent crates in
  the repository, so a crate in a distributed collection gets the
  distributed collection's root whatever order the crates are indexed in. If
  a parent collection moves, reindex the crates under it: they keep the old
  `rootCollection` until then.
- **Aggregates**: Oni shows each entity's counts of the collections, objects
  and files below it, and the languages, communication modes and media types
  at or below it. Each index job stores what its crate adds to every entity
  above its own, including collections in parent crates, and the API sums
  those per page (`src/oni.ts`), so a collection split across crates reads as
  one.
- **Sign-in**: the API is its own OIDC provider, signing users in at an
  upstream provider such as CILogon (`src/oidc/`,
  [ADR 0001](docs/adr/0001-own-oidc-provider.md)).
- **Admin pages**: server-rendered pages at `/admin/` on their own origin,
  where admins, who sign in through our own OIDC provider, see and rebuild or
  delete indexes (`src/admin/`,
  [ADR 0002](docs/adr/0002-server-rendered-admin-pages.md)).

The ADRs linked here are ldacapi's own, in `docs/adr/`, not arocapi's.

## Getting started

You need Node.js 26 (26.13 or later), [pnpm](https://pnpm.io/) and Docker.

```sh
pnpm install
docker compose up -d --wait   # Postgres, OpenSearch, Oni and a fake upstream provider
pnpm bootstrap                # migrate the database, import test-data into OCFL and index it
pnpm dev
```

| Service    | URL                                                   |
| ---------- | ----------------------------------------------------- |
| API        | <http://localhost:8080/api>                           |
| Oni        | <http://localhost:3000>                               |
| Admin      | <http://admin.localhost:8080/admin/>                  |
| OpenSearch | <http://localhost:9200>                               |
| Upstream   | <http://localhost:8090/default>                       |
| Postgres   | `postgresql://ldacapi:ldacapi@localhost:5432/ldacapi` |

Copy `.env.example` to `.env` before starting the API: it sets
`OPEN_LICENSES`, which is required (see [Licences](#licences)), and turns
sign-in on (see [Local sign-in](#local-sign-in)). To override a default, set
it in `.env`.

## Scripts

| Script                                                   | Does                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                               | Run the API and the worker, restarting on changes, and rebuild the admin pages' stylesheet                                                                                                                                                                  |
| `pnpm build`                                             | Build the admin pages' stylesheet (run before deploying)                                                                                                                                                                                                    |
| `pnpm test`                                              | Run the tests (needs `docker compose up`)                                                                                                                                                                                                                   |
| `pnpm lint`                                              | Biome, Knip and TypeScript                                                                                                                                                                                                                                  |
| `pnpm bootstrap`                                         | `db:deploy` and `crates:import --mode sync` in one go                                                                                                                                                                                                       |
| `pnpm ocfl:init`                                         | Create an empty OCFL repository at `OCFL_ROOT`, unless one exists already                                                                                                                                                                                   |
| `pnpm crates:import --mode sync\|add [--no-index] [dir]` | Import every crate at or below `dir` (default `test-data`) into the OCFL repository (see [Importing crates](#importing-crates)), then index each crate imported (unless `--no-index`), waiting for those jobs and summarising them; fails if any crate does |
| `pnpm index [--force]`                                   | Index every crate whose head version isn't indexed (`--force`: every crate), and delete the indexes of crates gone from the repository, then run the queue until those jobs are finished, summarising them; fails if any crate does                         |
| `pnpm worker`                                            | Run index jobs as they are asked for                                                                                                                                                                                                                        |
| `pnpm generate-keys`                                     | Print new `OIDC_SIGNING_KEYS` and `OIDC_COOKIE_KEYS` for `.env`                                                                                                                                                                                             |
| `pnpm db:migrate`                                        | Create and apply a migration after a schema change                                                                                                                                                                                                          |
| `pnpm db:deploy`                                         | Apply pending migrations                                                                                                                                                                                                                                    |
| `pnpm db:reset`                                          | Drop and recreate the dev database                                                                                                                                                                                                                          |
| `pnpm db:console`                                        | Open `psql` on the dev database                                                                                                                                                                                                                             |

## Test data

Each folder in `test-data/` is one RO-Crate. `pnpm bootstrap` imports them into the
OCFL repository at `storage/ocfl` (gitignored) with `--mode sync`, and re-running it only adds a
new OCFL version for crates that changed. It then indexes the crates it
imported.

### Importing crates

`pnpm crates:import` finds crates by walking `dir` and every folder below it
(ADR 0008):

- Every folder holding `ro-crate-metadata.json` is one crate, `dir` itself
  included, at any depth. A crate's OCFL object leaves out the folders of
  crates below it, so a collection's folder can hold its members' folders.
  Folders between them that aren't crates stay part of the crate above.
- Where a crate sits on disk says nothing about which collection it belongs
  to: that comes only from `pcdm:memberOf` and `pcdm:hasMember` in its
  metadata.
- Anything whose name starts with `.` is left out, between crates and inside
  them. `.DS_Store`, `._*`, `.Spotlight-V100`, `.Trashes` and `.fseventsd` are
  left out silently; anything else, such as `.git`, with a warning naming it.
- Symlinks are never followed: each is left out with a warning.
- A folder outside any crate that leads to no crate gets a warning (only the
  highest such folder), as does a `dir` holding no crate at all. Warnings
  don't fail the import.
- A folder that can't be read, a crate whose metadata can't be read, a crate
  whose root `@id` isn't an absolute IRI (such as `./`, which means it has no
  id of its own), and folders whose crates share a root `@id` are all skipped.
  The rest still import, and the import fails at the end.

`--mode` is required:

- `sync` makes each crate's new OCFL version hold exactly what its folder
  holds.
- `add` adds and replaces files from each folder and removes none, for a
  directory of new or changed files.

Either way, a crate whose folder hasn't changed gets no new version, every
earlier version is kept, and no crate is deleted.

To index an OCFL repository that already holds crates, in place, point
`OCFL_ROOT` at it and run `pnpm index`: it lists every crate in the repository
and indexes each one.

A crate with no metadata licence (the `license` of `ro-crate-metadata.json`)
fails its index job unless `DEFAULT_METADATA_LICENSE` is set, and one with no
content licence (the `license` of the root dataset) fails unless
`DEFAULT_LICENSE` is set (see [Licences](#licences)). `pnpm crates:import`
rejects a crate whose root id isn't an absolute IRI, and indexing fails one
that reached the repository some other way.

## Indexing

Indexing runs in the worker (`pnpm worker`; `node src/worker.ts` in the
image), never in the API. The admin pages, `pnpm index` and
`pnpm crates:import` only ask for index jobs, which wait in a queue in
Postgres. Each job is for one crate: "a crate and those under it" and "every
crate" become one job per crate. Deleting every index is one job with no
crate.

### The worker

- It runs one job at a time. A job reads its crate from the repository, writes
  its database index (crate links, and Entity and File rows), then its search
  index, then its share of Oni's aggregates, then records the crate's indexed
  version.
- Index skips a crate whose indexed version is its head version. Reindex
  deletes and rebuilds it whatever its version.
- Indexing a crate gone from the repository deletes its indexes and its record,
  and succeeds; the record stays, not indexed, if another job for the crate
  has been asked for meanwhile.
- Any error in a crate fails its job at once, and nothing in it is skipped, so
  an indexed version always means the whole crate is indexed: an entity whose
  row can't be written fails it, as does a document search refuses. The failed
  job records the error's message, its stage (reading the crate, deriving,
  database index, search index or aggregates), the entity or file it was on,
  when, and which attempt; the stack trace goes only to the log, with the job
  id. Nothing retries it: fix the crate, then ask again. Indexing and deleting
  are both safe to repeat.
- A file the crate describes but doesn't hold is indexed and searchable, with
  no content to preview or download (404), and one warning per crate counts
  them. A held file that can't be read fails the job.
- It never forces a search refresh, so new documents become searchable at
  OpenSearch's next periodic refresh, within a second by default.
- It writes a heartbeat to Postgres every 30 seconds, saving with it the
  running job's stage and how much of it is done, of how much; that write is
  the only one progress costs. The admin pages show "No worker running" when
  no worker has written one for 5 minutes.
- It logs a line when a job starts (job id, crate id, kind, attempt), when it
  finishes (duration, version, entity and file counts) and when it fails
  (crate id, job id, stage, stack trace). At `LOG_LEVEL=debug` it also logs
  each entity it indexes, each file whose text it reads, and each crate
  skipped as already indexed.
- On SIGTERM or SIGINT it stops once the step the running job is on ends, puts
  that job back in the queue, as if never tried, and exits. If Postgres can't
  be reached then, it exits anyway, leaving the job to be recovered as a dead
  worker's.
- A worker silent for 5 minutes is dead. The next worker or `pnpm index` to
  look for work puts its job back in the queue, to run again; a job whose
  worker dies on three attempts fails. A worker wrongly judged dead stops its
  job when its next heartbeat finds another worker holds it, and writes
  nothing more.
- A crate whose root id isn't the id of the OCFL object holding it fails at
  deriving.
- If Postgres or OpenSearch can't be reached, it logs that it has paused, puts
  its job back in the queue, and tries again every 5 seconds, carrying on once
  both answer.
- `pnpm index` and `pnpm crates:import` work the queue as a worker does, and
  write the same log lines, until no job is waiting and every job they asked
  for has finished, whichever worker ran it. Then they log how many of the
  crates they asked for were indexed, skipped, deleted and failed, and each
  failure with its error, read from Postgres, and exit non-zero if any
  failed.

### Index states

The admin pages' crates page shows one state per crate, and counts the crates
in each state at the top:

| State       | When                                                | Shows                                                                                                                                         |
| ----------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| not indexed | it has no indexes                                   |                                                                                                                                               |
| queued      | an index or reindex job waits                       |                                                                                                                                               |
| indexing    | an index or reindex job is running                  | its stage, how much of it is done as of the last heartbeat, and when it started: "search index, 12,000 of 30,000, since 2026-11-17 10:42 UTC" |
| deleting    | a delete job waits or runs, or deleting every index |                                                                                                                                               |
| indexed     | its last job succeeded                              | version, when, entities and files                                                                                                             |
| failed      | its last job failed                                 | the error, its stage, the entity or file it was on, when, and which attempt                                                                   |

A waiting or running job comes first, then a failed one, then what the last
successful job recorded. A crate is listed once a job has been asked for it,
so "Index all" lists every crate in the repository.

### Shared entities and clashes

A crate link records each entity a crate contains; it is the only record of an
entity's crates. A crate's entity and file counts are its links, so an entity
two crates contain counts in both.

- **People, organisations and software** are shared entities: any number of
  crates may describe the same one (one absolute IRI, such as an ORCID). Each
  crate's link keeps its own copy, and the row and search document are wholly
  one crate's copy: a crate whose metadata licence is open first, then the
  lowest crate id. Copies are never merged, and indexing the crates in any
  order gives the same rows. A person a crate mentions without the LDaC
  profile has no link to it.
- **Deleting a crate**, or reindexing it once it no longer contains an entity,
  removes its links, then the entities no crate links to. A shared entity whose
  winning crate goes becomes the next crate's copy, from the copy kept on its
  link, without reading the repository.
- **A clash** fails the job: a crate describing a collection, object or file
  another crate already holds, or an id another crate describes as a different
  kind of entity. The error names the entity and both crates, and the crate
  holding it keeps its row. The failed crate shows as failed until its data is
  fixed.
- **A copy of a collection above the crate** (its parent, its parent's parent,
  and so on, found through `pcdm:memberOf` in the repository) isn't a clash. The
  crate's copy is left out, with a warning naming it, and the collection's own
  crate holds it, whatever order the crates are indexed in
  ([ADR 0009](docs/adr/0009-a-copy-of-an-ancestor-collection-is-left-out.md)).

### More than one worker

Workers share the queue: each claims the oldest waiting job that no other
worker holds, and two jobs for one crate never run at once. Deleting every
index waits for the running jobs to finish and runs alone. To run more, start
more workers against the same database, search index and repository, such as
`docker compose up -d --scale worker=3` in [production](#production-with-docker-compose).
Each worker holds one crate's metadata in memory at a time, and remembers
each crate's parent collection (ids only), so a parent crate is read once
rather than once per crate under it. Node sets its heap limit from the
machine's memory (about 2 GB on an 8 GB host); to set it yourself, give the
worker `NODE_OPTIONS=--max-old-space-size=<MB>`.

### Known limits

- There's no rebuild without a gap: "Reindex all" runs with the API up, so a
  crate drops out of the API while its job runs.
- A change to the search fields needs a maintenance window: delete the search
  index and index every crate again (see [Running it](#running-it)).
- Only the first 1,000,000 bytes of a `text/*` file are searchable; a file cut
  short is logged.
- A changed parent crate leaves the crates under it stale (their
  `rootCollection`, and what they add to the aggregates of the collections
  above them) until they are reindexed.
- Entities' `Public` and `AuthorizationByApplication` labels, and which crate's
  copy of a shared entity wins, lag a change to `OPEN_LICENSES` until their
  crates are reindexed.
- Which of two clashing crates holds a collection, object or file depends on
  which was indexed first; the other fails on every run until the data is
  fixed.
- Reindexing the crate whose copy of a shared entity wins briefly shows the
  next crate's copy while its job runs.
- A crate put in the repository by another tool isn't listed on the admin pages
  until "Index all" runs.
- A crate on the older bare spelling (`memberOf`, `communicationMode` rather
  than `pcdm:memberOf`, `ldac:communicationMode`) indexes without its parents
  or LDaC facets, with no warning.
- A crate too large for node's heap stops the process running its job; after
  three tries the job fails with "Its worker died on each of 3 attempts".
  Raise the limit with `NODE_OPTIONS=--max-old-space-size=<MB>` to index it.

## Configuration

Configuration comes only from environment variables, validated at startup
(`src/configuration.ts`). `pnpm dev`, `pnpm crates:import`, `pnpm index` and Prisma
also read `.env` if it exists, without overriding variables that are already
set.

| Variable                                                   | Default                                               |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `NODE_ENV`                                                 | `development`                                         |
| `DATABASE_URL`                                             | `postgresql://ldacapi:ldacapi@localhost:5432/ldacapi` |
| `OPENSEARCH_URL`                                           | `http://localhost:9200`                               |
| `OCFL_ROOT`                                                | `storage/ocfl`                                        |
| `LDACAPI_PORT`                                             | `8080`                                                |
| `LDACAPI_HOST`                                             | `localhost`                                           |
| `LDACAPI_MAX_PARAM_LENGTH`                                 | `500`                                                 |
| `LOG_LEVEL`                                                | `debug` in development, otherwise `info`              |
| `ENTITY_INDEX`                                             | `entities`                                            |
| `OPEN_LICENSES`                                            | none; always required                                 |
| `DEFAULT_METADATA_LICENSE`                                 | none                                                  |
| `DEFAULT_LICENSE`                                          | none                                                  |
| `REMS_USER`, `REMS_KEY`, `REMS_ENDPOINT`, `ENROLLMENT_URL` | none                                                  |
| `OIDC_UPSTREAM_ISSUER`                                     | none (sign-in is off)                                 |
| `OIDC_UPSTREAM_CLIENT_ID`, `OIDC_UPSTREAM_CLIENT_SECRET`   | none                                                  |
| `OIDC_ISSUER`                                              | `http://localhost:8080`                               |
| `OIDC_CLIENTS`                                             | `[]`                                                  |
| `OIDC_SIGNING_KEYS`, `OIDC_COOKIE_KEYS`                    | generated at each start outside production            |
| `ADMIN_ORIGIN`                                             | `http://admin.localhost:8080` outside production      |
| `ADMIN_USERS`                                              | none (nobody is an admin)                             |

`OPEN_LICENSES` must always be set (see [Licences](#licences)). With
`NODE_ENV=production`, `DATABASE_URL`, `OPENSEARCH_URL` and `OCFL_ROOT` also
have no defaults and must be set.

### Licences

Every entity has a metadata licence, which guards its RO-Crate metadata
(`/entity/:id/metadata`), and a content licence, which guards a file's bytes
(`/file/:id`)
([two licences per entity](https://arocapi.crate-works.org/concepts/licences/#two-licences-per-entity)).
The indexer takes the metadata licence from the `license` of
`ro-crate-metadata.json`, and the content licence from the entity's own
`license`, else the nearest parent's in the crate that has one, else the root
dataset's.

Each default fills in only its own licence: `DEFAULT_METADATA_LICENSE` the
metadata licence, and `DEFAULT_LICENSE` the root dataset's content licence,
which every entity with none of its own or from a parent inherits. Most
production crates have no metadata licence, so production needs
`DEFAULT_METADATA_LICENSE`.

`OPEN_LICENSES` lists the open licences, comma-separated: anyone may read
what they cover, signed in or not, and the indexer labels entities under them
`Public` for Oni (`AuthorizationByApplication` otherwise). The API refuses to
start without it. `.env.example` lists five Creative Commons licences:

```dotenv
OPEN_LICENSES=https://creativecommons.org/licenses/by/3.0/au/,https://creativecommons.org/licenses/by/4.0/,https://creativecommons.org/licenses/by-nc/4.0/,https://creativecommons.org/licenses/by-nd/3.0/au/,https://creativecommons.org/licenses/by-nc-nd/4.0/
```

The request-time check follows a change to the list at once, but stored labels
only catch up when the crate is reindexed.

Any other licence needs an entitlement to it in REMS, looked up at `REMS_ENDPOINT` with `REMS_USER`
and `REMS_KEY`, once per request. If REMS can't be reached or returns an
error, the API logs it and treats the user as holding no licences, so
restricted entities are refused until it recovers.

A refused request gets 401 if it is anonymous, so the client can prompt a
sign-in, and 403 if it is signed in
([Denied is 401 or 403](https://arocapi.crate-works.org/concepts/visibility-vs-access/#denied-is-401-or-403-never-404)).
The enrolment link isn't on the error: every entity the API returns carries
an `access` object, and for each licence the user doesn't hold it has a
`metadataAuthorizationUrl` or `contentAuthorizationUrl`. That link is
`ENROLLMENT_URL` with every `{licenseId}` replaced by the URL-encoded licence
id, e.g.

```dotenv
ENROLLMENT_URL=https://rems.example.org/apply-for?resource={licenseId}
```

Without `ENROLLMENT_URL` no link is offered. The API refuses to start if it
has no `{licenseId}`, isn't a URL (https in production), or uses the old
`${licenseId}` form (drop the `$`).

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

Downloads and media players can't send a bearer token, so for restricted
files to download and play in Oni, serve Oni and the API from the same origin
and set Oni's `api.rocrate.usesTokenCookie` to `true`. Oni then keeps
its access token in the `oni_access_token` cookie, and the API accepts it on
`/api/file/:id`, except on requests from other sites. arocapi marks those
responses `Cache-Control: private, no-cache`
([Caching](https://arocapi.crate-works.org/configuration/access/#caching)), so
shared caches don't keep restricted files. See
`docs/adr/0010-file-requests-take-a-token-cookie.md`.

### Local sign-in

Docker Compose runs a fake upstream provider,
[mock-oauth2-server](https://github.com/navikt/mock-oauth2-server), at
`http://localhost:8090/default`, and `.env.example` is set up to use it:

```sh
cp .env.example .env
pnpm dev
```

Sign in through Oni or the admin pages, and the fake provider asks for a
username. Type any; it becomes your `sub`, with `name` the same and `email`
`<username>@example.com`. Sign in as `admin` to use the admin pages, or add your
username to `ADMIN_USERS` in `.env`. Anyone else sees "Not an admin".

To try the [Downloader](#the-downloader) against `pnpm dev`, run
`docker compose --profile downloader up -d` and open `http://localhost:7000`.
[moto](https://github.com/getmoto/moto) stands in for S3 and SES. The zip's
link works from the export page, and the emails sent are under `ses` in
`http://localhost:5000/moto-api/data.json`.

### Admin pages

The admin pages are at `<ADMIN_ORIGIN>/admin/`. `ADMIN_ORIGIN` is an origin,
with no path, such as `https://admin.example.org`, and must differ from
`OIDC_ISSUER`. Crate files are served on the API's origin with their own
content type. arocapi sandboxes them, except audio and video, but that rests
on each response's headers, so a separate origin keeps any script a crate file
does run away from admin (ldacapi's
[ADR 0002](docs/adr/0002-server-rendered-admin-pages.md)). It defaults to `http://admin.localhost:8080`
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

The crates page shows each crate's index state. It can index, reindex or
delete one crate's indexes, or a crate's and those of the crates under it (the
"tree" actions): the listed crates whose id is the crate's id followed by `/`.
It can also index or reindex every crate in the repository, which deletes the
indexes of crates gone from it and fails a crate it can't read, or delete every
index, which empties both indexes, discards the jobs waiting, clears every
failure and leaves every crate listed as not indexed. If deleting every index
fails, the page says so, with the error, until it next succeeds. An
action on a crate the page doesn't list is refused. The page reloads itself
until the work finishes. Each action, accepted or refused, is logged at `info`
with the admin's `sub`.

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

To try a branch before merging it, open **Actions → Build image → Run
workflow** and pick the branch. That skips lint and test but still runs the
smoke test, then publishes the image tagged with the branch name
(`debug/admin-users` becomes `debug-admin-users`) and `sha-<short>`. It won't
build `main`. Old branch tags stay until you delete them from the package's
page on GitHub.

Put the API's configuration in an environment file, such as `ldacapi.env`, and
start it. Docker keeps quotes in an environment file's values, so don't quote
them. Don't set `LDACAPI_HOST` there: the healthcheck requests `127.0.0.1`, so
the API must keep listening on `0.0.0.0`.

```sh
docker run -d --env-file ldacapi.env -p 8080:8080 --mount type=bind,src=/srv/ldacapi/ocfl,dst=/ocfl \
  ghcr.io/language-research-technology/ldacapi:main
```

Below, `ldacapi` stands for the image, which you can also build yourself with
`docker build -t ldacapi .`.

### One-off commands

The container never migrates the database when it starts. Before a rollout,
apply the migrations once from the new image, so several replicas never race
to migrate:

```sh
docker run --rm --env-file ldacapi.env --mount type=bind,src=/srv/ldacapi/ocfl,dst=/ocfl ldacapi pnpm db:deploy
```

`pnpm ocfl:init` (which creates an empty OCFL repository; the API won't start
without one), `pnpm crates:import --mode sync|add [dir]` (mount `dir` into the container) and
`pnpm index` run the same way, offline. Give them and `pnpm db:deploy` the API's environment file:
Prisma and the scripts load the whole [configuration](#configuration).
`pnpm generate-keys` reads no configuration, so it needs no environment file:

```sh
docker run --rm ldacapi pnpm generate-keys >> ldacapi.env
```

### Storage

Mount the OCFL repository at `/ocfl`, the image's `OCFL_ROOT`. For a new
repository, mount an empty directory and run `pnpm ocfl:init` to create the
repository in it. The directory must exist: `--mount` refuses a missing one,
where `-v` would create it owned by root, which the API can't write to. The API runs as the image's `node` user, uid 1000, so the OCFL repository must be readable by
uid 1000. `pnpm crates:import` writes to the repository, so give it write access
too when you run it.

## Production with Docker Compose

`deploy/` runs the whole service on one host: [Caddy](https://caddyserver.com/)
in front, Oni, the API, Postgres and OpenSearch. Caddy is the only container
with published ports (80 and 443), and it gets and renews HTTPS certificates
from Let's Encrypt on its own. It serves three hostnames:

| Hostname            | Path                                                      | Goes to                                                      |
| ------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `DOMAIN`            | `/api/*`, `/oauth/*`, `/.well-known/openid-configuration` | The API                                                      |
| `DOMAIN`            | `/configuration.json`                                     | Oni's configuration, served by Caddy with `DOMAIN` filled in |
| `DOMAIN`            | everything else                                           | Oni                                                          |
| `ADMIN_DOMAIN`      | `/admin/*`                                                | The API's admin pages                                        |
| `DOWNLOADER_DOMAIN` | everything                                                | The [Downloader](#the-downloader)                            |

The admin pages need their own hostname (see [Admin pages](#admin-pages)).
Caddy sets no Content-Security-Policy on the API's responses: arocapi sends
crate files with `nosniff` and, except audio and video, a `sandbox`
Content-Security-Policy, which gives any HTML or SVG in a crate an opaque
origin, so its scripts can't reach Oni's sign-in on `DOMAIN`
([protective headers](https://arocapi.crate-works.org/configuration/storage/#protective-headers)).
Audio and video are left out so they play when opened directly. On every
hostname Caddy adds HSTS, `nosniff` and a `strict-origin-when-cross-origin`
referrer policy, and Oni's and the Downloader's pages also get
`X-Frame-Options: SAMEORIGIN`.

No other container publishes a port, on the host or on localhost, so Postgres,
OpenSearch, the API and Oni are reachable only from within the stack.
OpenSearch's security plugin is off for that reason. Every container runs with
`no-new-privileges`, and the API, Oni and Caddy run with read-only root
filesystems.

### Setting it up

You need Docker with Compose, ports 80 and 443 open, DNS for `ADMIN_DOMAIN` and
`DOWNLOADER_DOMAIN` pointing at the host, and the Downloader's
[AWS resources](#the-downloader). `DOMAIN`'s DNS follows once the crates are indexed
(step 5 of [Installing](#installing)). OpenSearch also needs a larger mmap
limit on the host:

```sh
echo vm.max_map_count=262144 | sudo tee /etc/sysctl.d/99-opensearch.conf
sudo sysctl --system
```

The OCFL repository is a directory on the host, usually on an NFS mount, set
by `OCFL_DIR` in `.env`. It must exist before the stack starts: Compose won't
create it. For a new repository, make it empty. Imports are staged
inside the repository, in `extensions/ocfl-js-workspace`, and committed by
renaming them into place, so the repository must be on one filesystem, with no
mount point inside it, and that filesystem must support hard links, as NFS
does. The API runs as uid 1000, so the directory must be writable by
uid 1000: on NFS, set the owner on the server or map the export to uid 1000, as
root in the container is squashed. Otherwise `pnpm ocfl:init` fails with
`EACCES: permission denied, open '/ocfl/ocfl_1.1.md'`. Serving and indexing only
read, so a read-only mount works if you import crates elsewhere.

Caddy's certificates, Postgres and OpenSearch keep their data in `data/`
beside `compose.yaml`. OpenSearch runs as uid 1000 and can't fix its own
directory's owner, so create it first.

Copy `deploy/` to the host, then, in it, set it up:

```sh
sudo install -d -o 1000 -g 1000 data/opensearch
sudo install -d -o 1000 -g 1000 /mnt/ldacapi/ocfl   # OCFL_DIR, unless it exists already
cp .env.example .env                  # the hostnames, ACME_EMAIL, the secrets and OCFL_DIR
cp ldacapi.env.example ldacapi.env    # sign-in, admins, open licences and the API's other settings
cp downloader.env.example downloader.env  # the Downloader's session secret and AWS settings
chmod 600 .env ldacapi.env downloader.env
docker compose run --rm --no-deps api pnpm -s generate-keys >> ldacapi.env
```

Register `https://<DOMAIN>/oauth/callback` as the redirect URI at the upstream
provider. Compose sets the API's database, OpenSearch, storage, `OIDC_ISSUER`,
`ADMIN_ORIGIN` and Oni's and the Downloader's clients in `OIDC_CLIENTS` from
`.env`, so leave those out of `ldacapi.env`. Edit `oni/configuration.json` to change what Oni shows. Its
endpoints use `DOMAIN`, so don't change them.

### Installing

On a new host, in `deploy/`:

1. Migrate the database:

   ```sh
   docker compose run --rm api pnpm db:deploy
   ```

2. Put the crates in the repository. Either set `OCFL_DIR` to a repository
   that already holds them, or import them without indexing, which
   creates the repository if there isn't one:

   ```sh
   docker compose run --rm -v /path/to/crates:/import:ro api pnpm crates:import --mode sync --no-index /import
   ```

3. Start the API and the worker, with the rest of the stack:

   ```sh
   docker compose up -d
   ```

4. Ask for every crate to be indexed: **Index all** on the admin pages
   (`https://<ADMIN_DOMAIN>/admin/`), or

   ```sh
   docker compose run --rm api pnpm index
   ```

   `pnpm index` works the queue beside the worker and exits once every job it
   asked for has finished, whichever worker ran it, summarising them.

5. Switch traffic once the admin pages show every crate as indexed and none
   failed: every count at the top but "indexed" is 0. Point `DOMAIN`'s DNS at
   the host, then run `docker compose restart caddy` so Caddy gets its
   certificate straight away.

Nothing migrates the database on its own: you run `pnpm db:deploy` when you
install and when you upgrade, after taking a backup.

OpenSearch is pinned to an exact version in both `deploy/compose.yaml` and the
development `docker-compose.yml`, so bump the two together: its data directory
can be upgraded but not downgraded. If it won't start after an upgrade, stop
it, recreate `data/opensearch` as above, start it and rebuild the indexes with
`docker compose run --rm api pnpm index --force`.

### Running it

Import crates and index them with the API's image, mounting the directory of
crates read-only (`--mode add` instead adds to the crates without removing any
files; see [Importing crates](#importing-crates)):

```sh
docker compose run --rm -v /path/to/crates:/import:ro api pnpm crates:import --mode sync /import
```

To index a repository that already holds crates in place, run
`docker compose run --rm api pnpm index`.

The stack runs the API's `main` image. To upgrade, back up the database and
`OCFL_DIR`, then pull the new images, apply any new migrations and restart:

```sh
docker compose exec -T db pg_dump -U ldacapi -Fc ldacapi > ldacapi-$(date +%F).dump
docker compose pull
docker compose stop api worker
docker compose run --rm api pnpm db:deploy
docker compose up -d
```

`pnpm index --force` rebuilds both indexes of every crate, so run it when an upgrade
changes what they hold. If an upgrade changes the search fields, the worker,
`pnpm index` and `pnpm crates:import` stop with an error naming the changed
field, as they check the search index's mapping before running any job. Delete
the search index (named by `ENTITY_INDEX`, `entities` by default) first, then
rebuild and start again:

```sh
docker compose exec opensearch curl -sX DELETE localhost:9200/entities
docker compose run --rm api pnpm index --force
docker compose up -d
```

To run a branch's image (see [Docker image](#docker-image)) on a dev
deployment, change the API's `image` tag in `compose.yaml` from `main` to the
branch's tag and follow the upgrade steps above. Migrations the branch adds
stay applied after you switch back to `main`; if the branch changes them before
merging, restore the database from the backup.

To restore the database from a backup, stop the API and run
`docker compose exec -T db pg_restore -U ldacapi -d ldacapi --clean < ldacapi-<date>.dump`.

### The Downloader

The [Downloader](https://github.com/crate-works/downloader) lets a signed-in
user pick files across collections and get them as one zip: it streams them
from the API with the user's access token, uploads the zip to S3 and emails a
link to it, valid for 24 hours, through SES. It signs in through the API as the
`downloader` client, with `DOWNLOADER_CLIENT_SECRET` from `.env`, and calls the
API inside the stack rather than through Caddy. Its image rewrites its own
files at start, so it is the one container whose root filesystem isn't
read-only.

It needs, in the region set by `AWS_REGION` in `downloader.env`:

- An S3 bucket, `S3_BUCKET`, with a lifecycle rule that deletes objects after
  2 days, as nothing else deletes the zips.
- SES out of the sandbox, with `EMAIL_FROM`'s domain verified, so it can email
  any user.
- An IAM user for `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, allowed only
  `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and
  `s3:AbortMultipartUpload` on the bucket's objects, and `ses:SendEmail`.

Its sign-in lasts as long as one access token, 15 minutes, as it doesn't
refresh tokens. Past that the user signs in again, which the API's session
makes a click. An export keeps the token it started with, so one still
running after 15 minutes gets the files anyone may read but lists the rest as
missing in its email.

The Downloader's image is pinned to a version in `compose.yaml` and in the
development `docker-compose.yml`; bump the two together.

## Release notes

### The indexer redesign

Indexing moves out of the API into the worker, with its jobs and each crate's
index state in Postgres (see [Indexing](#indexing)). Rebuild both indexes
after upgrading: there's no upgrade path for the indexes, or the index state,
an earlier release built. Install on a new host as in
[Installing](#installing) where you can. To upgrade in place, follow the
upgrade steps in [Running it](#running-it), but delete the search index after
`pnpm db:deploy` and index every crate again:

```sh
docker compose exec opensearch curl -sX DELETE localhost:9200/entities
docker compose run --rm api pnpm index --force
docker compose up -d
```

The [known limits](#known-limits) apply from this release.

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
