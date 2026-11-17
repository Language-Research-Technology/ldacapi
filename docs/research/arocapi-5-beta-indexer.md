# What arocapi 5 beta offers an indexer

Research for #66 (map #65, indexer redesign). Facts only; decisions belong to the grilling tickets.

Checked on 2026-11-17 against:

- `node_modules/arocapi`, version `5.0.0-beta.10` (what ldacapi installs).
- crate-works/arocapi: `main` and `beta` both at `2706838`, which is `v5.0.0-beta.10` (`f4cd98e`) plus one docs-only
  commit to ADR 0004. So the latest beta, `main` and the installed package have the same code.
- arocapi's open and closed issues and PRs, its ADRs (`docs/adr/`), and the docs site source
  (`website/src/content/docs`, published at <https://arocapi.crate-works.org>).
- The RO-Crate API spec's deposit page (crate-works/ro-crate-api `docs/deposit/index.md`), for `roCrateIds`.

Code links below are to the `v5.0.0-beta.10` tag: `https://github.com/crate-works/arocapi/blob/v5.0.0-beta.10/<path>`.

## Summary

- **arocapi never writes the database.** Its Prisma surface is `findMany`/`findFirst`/`count` on `entity` and `file`
  only. All `Entity` and `File` rows come from the consumer's indexer. The docs say so: "arocapi serves what is in your
  database and index; it doesn't write to them."
- **No storage backend derives entities or file meta.** Each one reads a location the indexer wrote into `meta` (or a
  consumer `locate` function) and serves bytes. None enumerates objects, parses a crate, or fills `File`
  columns.
- **Search writes are on the contract** (`index(docs)`, `remove(ids)`), but the consumer builds every search document.
  arocapi never derives a document from an entity.
- **No indexer, ingest or deposit code exists or is in progress** in arocapi. `/capabilities` reports
  `deposit: { supported: false }`. Deposit is "coming soon" in the docs, with no issue, branch or design. The models
  have no `roCrateIds`.
- **`OpenSearchBackend`**: one `client.bulk` per `index`/`remove` call (no chunking), `refresh` set once per backend
  instance (not per call), `createIndex()` sets mappings only. Index settings are proposed in open issue
  crate-works/arocapi#143.
- **Of #47's arocapi-boundary candidates, only index settings has an upstream issue** (#143). `deriveUniqueEntityIds`,
  `pickSingleMemberOf`, `entityAsCrate`, file storage meta, shared-entity upserts and a `meta.crateId` index appear
  nowhere upstream.

## 1. Storage backends

The contract is `StorageBackend = { metadata: MetadataSource; content: ContentSource }`
(`src/storage/backend.ts:55`). Both halves are read-only. ADR 0004 says: "The contract has no writes. A deposit API would add its own key on
`storage`" (`docs/adr/0004-pluggable-storage-backends.md`, "Writes").

| Backend (subpath) | Metadata reads | Content reads | Derives anything? |
| --- | --- | --- | --- |
| `OcflStorage` (`arocapi/storage/ocfl`) | `Entity.meta.ocflObject` + `Entity.meta.ocflPath` (default `ro-crate-metadata.json`) | `File.meta.ocflObject` + `File.meta.ocflPath` | No |
| `EntityMetaMetadata` (`arocapi/storage/entity-meta`) | the JSON object at `Entity.meta.rocrate` (or `key`) | none (Metadata half only) | No |
| `DirectoryStorage` (`arocapi/storage/directory`) | `Entity.meta.storagePath` | `File.meta.storagePath` | No |
| `S3Storage` (`arocapi/storage/s3`) | `Entity.meta.storageKey` | `File.meta.storageKey` | No |

Sources: `src/storage/backend.ts:66-72` (the exported `DirectoryStorageMeta`, `S3StorageMeta`, `OcflStorageMeta` types),
`src/storage/entity-meta/entity-meta.ts:12`, docs [Reference → Entity meta](https://arocapi.crate-works.org/reference/entity-meta/).

Details that matter to an indexer:

- **`OcflStorage`**: an async factory. It opens the storage root once (`openStorageRoot(root)`, `src/storage/ocfl/ocfl.ts:43`) and,
  per request, opens one object by id (`storageRoot.open(location.object)`, `:51`) and looks up the logical path in
  its **head** version. It streams the file and takes `contentLength`, ETag (inventory digest) and `lastModified` from
  OCFL, not from the `File` row. It never lists objects or reads a crate. `Content-Type` comes from `File.mediaType`.
  Since beta.10 (crate-works/arocapi#144, PR #145) it is built on `@ocfl/ocfl-fs` `1.0.0-beta.59` and delivers streams,
  not paths.
- **`ocflPath` is the plain logical path** (`my file.wav`), not the URI-encoded `@id`. "the indexer decodes it"
  (resolution of crate-works/arocapi#114). ADR 0004's consequences say: "ldacapi's indexer must write `ocflObject`".
- **`EntityMetaMetadata`** serves whatever object the indexer stored. The docs warn "the copy is only as fresh as your last index run"
  (`website/src/content/docs/strategies/storage.mdx:42`). ldacapi uses it for Metadata (`src/app.ts`, built by
  `entityAsCrate`) and `OcflStorage`'s Content half for Content.
- **Missing vs malformed** (all backends): a missing key gives a 404. A key that isn't a string (`null` included), or that is absolute or has a
  `..` segment, gives a 500, "because it is an indexing bug" (crate-works/arocapi#113 resolution; `src/storage/location.ts`).
- Every backend also takes a **`locate`** option, which overrides where it looks for each item. ADR 0004 and #113 say a future
  deposit API would call the same `locate` to choose where to write.

## 2. What arocapi reads from rows and search documents

### `Entity`

Schema (`prisma/models/entity.prisma`): `id` (PK), `name`, `description`, `entityType`, `memberOf?`,
`rootCollection?`, `metadataLicenseId`, `contentLicenseId`, `meta Json?`, `createdAt`, `updatedAt`. It has indexes on
`memberOf`, `rootCollection` and `entityType` only (`:21-23`), and **no index on `meta`**.

What arocapi reads:

- **Record fields**: `baseEntityTransformer` (`src/transformers/default.ts:86`) copies `id`, `name`, `description`,
  `entityType`, `memberOf`, `rootCollection`, `metadataLicenseId`, `contentLicenseId`. These are the whole Record.
- **Reference resolution**: `memberOf` and `rootCollection` are resolved to `{ id, name }` by one `findMany` on the ids
  (`:120`). A parent that has no row comes back as `null`.
- **Listing**: `GET /entities` filters on `memberOf` and `entityType` and sorts on `id`, `name`, `createdAt` or `updatedAt`
  (`src/routes/entities.ts:24`, `:50`).
- **`meta`**: arocapi itself reads only the storage keys above. The whole row, `meta` included, is passed to the consumer's
  `access` function (crate-works/arocapi#139), entity transformers (#138) and file transformers (#140). The consumer's
  `entityVisibilityFilter` can query it. arocapi never sends `meta` in a response.
- **Licences**: the built-in `LicenceAccess` decides access from `metadataLicenseId` and `contentLicenseId` alone
  (`src/utils/access.ts`).

### `File`

Schema (`prisma/models/file.prisma`): `id` (PK, and FK to `Entity.id`), `filename`, `mediaType`, `size BigInt`,
`meta Json?`, `createdAt`, `updatedAt`.

- `baseFileTransformer` (`src/transformers/default.ts:105`) returns `id`, `filename`, `mediaType`, `size`.
- `GET /files?memberOf=` filters on the **file entity's** `memberOf` (`src/routes/files.ts:40`). So a file needs an
  `Entity` row whose `memberOf` is set, as well as its `File` row.
- `GET /file/:id` loads the `File` with its `Entity`. Access is the file entity's, and `content(file, entity)` reads
  `File.meta` (and `Entity.meta`, for custom `locate`).
- `filename` is the default download name, and `mediaType` is the Content-Type.

### Search documents

- A search document is `{ id, ...declared fields }` (`SearchDocument<Fields>`, `src/search/fields.ts`). Keys
  must be declared fields; values are type-checked (`storeDocuments`). arocapi "never derives a search document from the
  entity" (arocapi ADR 0003, "The index").
- `/search` uses only the hit **ids** from the backend. It then loads `Entity` rows by id, re-applying
  `entityVisibilityFilter` (`src/routes/search.ts:147`), and drops any hit without a visible row with a warning (`:158`).
  The response's entities are Records built from rows, not from the documents.
- Any field the `searchVisibilityFilter` uses must be declared and written into every document (ADR 0003
  consequences). A field with no role is stored for visibility only and never published.

### The minimum an indexer must write

For arocapi's routes to work, the facts above require:

- one `Entity` row per entity with all non-null columns (`id`, `name`, `description`, `entityType`,
  `metadataLicenseId`, `contentLicenseId`), plus `memberOf` and `rootCollection` for the tree and breadcrumbs;
- for each file entity, a `File` row with the same id (`filename`, `mediaType`, `size`) and the Content storage keys
  in `File.meta`;
- the Metadata source's key in `Entity.meta`: `rocrate` for `EntityMetaMetadata`, or `ocflObject` (and `ocflPath`) for
  `OcflStorage`'s Metadata half;
- one search document per searchable entity, written after its `Entity` row, with every field the search visibility
  filter uses.

Anything else in `meta` (today ldacapi's `crateId` and `accessControl`) is for ldacapi's own callbacks.

## 3. Indexer, ingest, deposit, `roCrateIds`

- **None of these exist in arocapi**. Its Prisma surface is read-only: `ArocapiPrismaClient = { entity: PrismaDelegate; file:
  PrismaDelegate }`, where a delegate is `findMany | findFirst | count` (`src/app.ts:109`). `/capabilities` hard-codes
  `deposit: { supported: false }` (`src/routes/capabilities.ts:13`).
- **The docs on deposit**: "Support for the deposit routes is coming soon. Until then, you fill the database and search index
  yourself" (`reference/routes.mdx`). `getting-started/opensearch.mdx` says "RO-Crates deposited through the API will
  be indexed by arocapi, so you won't need separate code to keep the database and search index in step for them". ADR 0003: "Consumers write their own search documents and call `index`
  and `remove` until a deposit API calls them."
- **No design work**: no open issue, PR or branch covers deposit, ingest or an indexer. An issue search for `roCrateIds`,
  `indexer`, `deposit`, `ingest` or `crateId` returns nothing, and none of those names (nor `entityAsCrate`) appears in
  arocapi's code or docs except as prose about "your indexer" and future deposits. ADR 0004 only requires that storage not
  preclude deposit (writes would be a new key on `storage`, located through `locate`).
- **The closest prior art** is crate-works/arocapi#1, "crate exploder" ("Given a list of type values and a crate, return an
  array of smaller crates that can each be put into the arocapi index/db"). It was closed on 2026-03-30 after the comment
  "I assume you are doing something like this in `ldacapi`". A throwaway `exploder` branch (Aug 2025,
  `lib/explodeCrate.js`) was never merged.
- **`roCrateIds` comes from the RO-Crate API spec, not arocapi.** It is a deposit linkage field: `roCrateIds` on Entity ("the RO-Crates whose current versions
  contribute to the entity. Usually one; more when materialisation merges contributions"), `roCrateId` on File
  (singular, optional), and `entityIds` on an RO-Crate. Materialisation is "implementation-defined" and may be
  many-to-one: two crates describing the same `@id` may yield "one Person entity carrying both RO-Crates in its
  `roCrateIds`". Clients must treat the fields as optional. Pruning entities that lose their last contributor is
  implementation-defined. (crate-works/ro-crate-api `docs/deposit/index.md`.) arocapi's `Entity` and `File` models have
  no such columns, and its routes don't emit them. arocapi implements spec `0.5.0`.

## 4. `SearchBackend` and `OpenSearchBackend`

The contract (`src/search/backend.ts:76-84`) has `capabilities`, `search(request, context)`, `index(docs, options?: { tx?
})` ("Upsert search documents; each entity must exist first") and `remove(ids)` ("ignoring ids that aren't indexed").
It has no `count`, `get`, `clear` or reindex: "A rebuild is the consumer looping `index`" (ADR 0003). The write methods
were put on the contract so that a future deposit API can drive writes through any backend (crate-works/arocapi#74
resolution).

`OpenSearchBackend({ client, fields, indexName = 'entities', refresh = false })` (`src/search/opensearch/opensearch.ts`):

- **Bulk writes**: `index` validates the whole batch first (`storeDocuments` throws on the first bad document, before
  any write), then sends **one** `client.bulk` for the whole batch (`:157`, `:269`). It doesn't chunk, although the
  #74 resolution said "the backend chunks internally". After the bulk, it throws on the first item with an error, naming the id. OpenSearch
  bulk isn't atomic, so the other items in that request may already be stored. `remove` is one bulk of deletes,
  tolerating 404 (`:283`). The backend doesn't check that the entity rows exist (ADR 0003). `PostgresBackend` does: it
  throws naming the missing ids and stores nothing from the batch.
- **Refresh**: the `refresh` option (`boolean | 'wait_for'`, default `false`) is fixed when the backend is created and
  passed to every bulk `index` and `remove` (`:34`, `:78`, `:157`). There is **no per-call refresh** argument. The docs
  advise `'wait_for'` "if a write must be searchable as soon as it returns, or `true` in tests, at the cost of slower
  writes" (`configuration/search.mdx`). The factory holds no connection state of its own (the consumer owns the
  `client`), so it can be called more than once with the same client.
- **Mappings**: `createIndex()` (not on the contract) creates the index with `mappings: { dynamic: 'strict',
  properties }` built from the field declarations (`:248`). If the index exists, it compares mappings field by field and throws, naming the
  field, on any difference. Text fields get a `.exact` keyword sub-field (`ignore_above: 8191`). `id` is `keyword`.
- **Settings**: `createIndex()` passes **no settings**, so the index gets OpenSearch's defaults: one primary shard, one replica,
  `max_result_window` 10,000. Open issue **crate-works/arocapi#143** (2026-11-04) proposes a pass-through
  `settings` option, applied only when `createIndex()` creates the index and never compared. It cites ldacapi's
  `putIndexTemplate` workaround (`auto_expand_replicas: '0-1'`, `max_result_window: 100000`).
- Deleting an index, alias swaps and zero-downtime rebuilds aren't supported. ADR 0003 says they "can be added later without
  a breaking change".
- `PostgresBackend` accepts `{ tx }` so an entity and its search document commit together. Its `EntitySearch` table
  ships in arocapi's shared models with `ON DELETE CASCADE` from `Entity`, so ldacapi carries that table, empty.

## 5. Roadmap and open issues against #47's candidates

Open arocapi issues as of 2026-11-17: #143 (OpenSearch `settings`), #142 (batch transformers), #131 (S3 HEAD
presign), #89 (visibility over consumer tables), #70 (upgrade docs), #45 (Range requests). There are no milestones.

| #47 candidate | Upstream status |
| --- | --- |
| `deriveUniqueEntityIds` | Not mentioned anywhere upstream. |
| `pickSingleMemberOf` | Not mentioned anywhere upstream. |
| `entityAsCrate` | Not mentioned. `EntityMetaMetadata` serves whatever object is in `meta.rocrate`, and arocapi doesn't build it. |
| Building file storage meta | Not mentioned. arocapi exports the shape types (`OcflStorageMeta` etc.) only. |
| Shared-entity upserts | Not mentioned. The only related concept is the spec's many-to-one materialisation (`roCrateIds`). |
| A `meta.crateId` index | Not mentioned. `Entity` indexes only `memberOf`, `rootCollection`, `entityType`. The entity-meta docs say "JSON path filters can't use arocapi's indexes; for large repositories, store visibility flags in your own indexed columns." |
| OpenSearch index settings | **crate-works/arocapi#143**, open. |
| OpenSearch per-call refresh | No issue. A per-instance `refresh` option exists (see §4). |

Other open issues that touch the boundary:

- **crate-works/arocapi#142 (batch transformers)**: proposes `entityBatchTransformers`, called once per page with the
  entities and their rows. It cites ldacapi's microtask batching for Oni `counts` in `src/oni.ts`, and says `counts` belongs to the
  consumer, not arocapi. Its "To check" asks whether arocapi's table and column names (`entity`, `file`, `"memberOf"`,
  `"entityType"`), today `@@map` details, should be declared stable for raw SQL. This matters if the indexer precomputes
  aggregates instead (#47 question 5).
- **crate-works/arocapi#89 (visibility over consumer tables)**: `entityVisibilityFilter` is a Prisma `where` on `Entity`, and can't reach a
  consumer-owned table because Prisma needs the relation on both models. It proposes an `extension EntityExtension?` relation on
  `Entity`, with each consumer defining `EntityExtension` (1:1, cascade delete). Its research notes: Prisma has no one-sided relations, no
  `extend model`, and no raw SQL in `where`, and patching `Entity` is brittle. For 5.0 the filter stays `meta`-only. This
  is the constraint on any ldacapi-owned table keyed by entity (e.g. a crate↔entity join): arocapi's queries can't join to it today.
- arocapi's README says changes merged to `main` are published under the `beta` tag. v5 is still in beta, so breaking changes
  can land in any beta.
