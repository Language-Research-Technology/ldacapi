# LDaCA API

Serves RO-Crates from OCFL storage through the arocapi API, and controls access to them by licence.

## Language

arocapi's terms, such as **Record**, **Metadata**, **Content** and **Row**, mean what [arocapi's glossary](https://github.com/crate-works/arocapi/blob/main/GLOSSARY.md) says.

### Crates and indexes

**Crate**:
One RO-Crate, stored as one OCFL object in the repository. The unit of import, indexing and admin actions. A collection, object or file belongs to exactly one crate. A crate's copy of a collection above it is left out, with a warning, not a clash (ADR 0009).
_Avoid_: OCFL object (the storage), collection (what a crate may describe)

**Shared entity**:
A person, organisation or software entity that more than one crate may describe. The index keeps one copy of it (ADR 0006).
_Avoid_: Duplicate (a collection, object or file in two crates, which is an error unless one is a copy of a collection above its crate)

**Import**:
Bringing RO-Crates from a directory into the OCFL repository (`pnpm crates:import`), then indexing them. Every folder at or below the directory that holds RO-Crate metadata is one crate, which leaves out the folders of crates below it (ADR 0008).
_Avoid_: Seed, deposit

**Sync**:
The import mode in which each crate's new version holds exactly what its folder holds. Earlier versions are kept, and no crate is deleted.
_Avoid_: Mirror, replace

**Add**:
The import mode in which each crate's new version adds and replaces files from its folder and removes none.
_Avoid_: Merge, append

**Deposit**:
A crate sent through the deposit API, which writes it to the OCFL repository and indexes it.
_Avoid_: Import, upload

**Index**:
Building the database index and the search index from the repository, for one crate or all of them. A crate whose current version is already indexed is left alone. Both indexes can be deleted and rebuilt at any time.
_Avoid_: Import

**Reindex**:
Deleting a crate's indexes and building them again, whether or not its current version is already indexed.
_Avoid_: Force index, refresh

**Index job**:
A request, waiting or running, to index or reindex one crate or to delete its indexes. Indexing several crates is one index job for each.
_Avoid_: Task, index run

**Worker**:
The process that runs index jobs, separate from the API (ADR 0005).
_Avoid_: Indexer (the code that builds the indexes)

**Database index**:
The Entity and File rows that arocapi reads, written by the indexer (arocapi's Rows).
_Avoid_: Structural index

**Search index**:
The search documents in arocapi's search backend, one per entity that has a row.
_Avoid_: OpenSearch index (one backend's storage)

**Index state**:
What is known about a crate's indexes: not indexed, queued, indexing, deleting, indexed or failed. One state covers both indexes.
_Avoid_: Status

**Indexed version**:
The OCFL version of a crate that its indexes were built from.
_Avoid_: Head version (the latest in the repository, which may be newer)

**Virtual crate**:
The Metadata served for one entity: an RO-Crate with that entity as its root and everything it reaches up to the records it links to, which are stubs (ADR 0004). Never the crate as deposited.
_Avoid_: Entity crate, exploded crate

**Stub**:
A linked record in a virtual crate, reduced to its `@id`, `@type`, `name` and `description` (plus `filename` for a file). The rest is fetched from the API.
_Avoid_: Summary, reference (a bare `{"@id"}`)

**Metadata-only crate**:
A crate that describes files the repository doesn't hold. Its File entities are indexed and visible, but have no Content.
_Avoid_: Damaged crate (one that can't be read)

**Shared entity**:
An entity that more than one crate describes under the same absolute IRI, indexed as one entity.
_Avoid_: Duplicate entity

**Aggregates**:
What Oni shows about an entity and everything below it: how many collections, objects and files are below it, and which languages, communication modes and media types it and they have. A collection's aggregates take in members held in other crates.
_Avoid_: Counts (one part of them), summaries, facets (a search result's)

### Authentication

**Upstream provider**:
The one external identity provider, set by configuration, that users sign in at.
_Avoid_: IdP, CILogon (one instance of it), login provider

**User**:
A person who has signed in at the upstream provider, identified by that provider's subject identifier. REMS knows the same person by the same identifier.
_Avoid_: Account, member

### Access

**Visibility**:
Whether an entity exists for a request at all. Every entity is visible to everyone (ADR 0003).
_Avoid_: Access

**Access**:
What a request may read of a visible entity, decided by its metadata and content licences.
_Avoid_: Visibility, permissions

**Access control**:
How Oni tells users they can get an entity's content: `Public` when its content licence is open, otherwise `AuthorizationByApplication` (apply in REMS). The indexer decides it and stores it with the entity; it describes the licence, not what a particular request may read.
_Avoid_: Access, access level

### Admin

**Admin**:
A user who can use the admin pages, currently one whose `sub` is in `ADMIN_USERS`.
_Avoid_: Administrator, superuser, staff

**Admin pages**:
The server-rendered admin UI at `/admin/` on the admin origin (`ADMIN_ORIGIN`).
_Avoid_: Portal, admin API
